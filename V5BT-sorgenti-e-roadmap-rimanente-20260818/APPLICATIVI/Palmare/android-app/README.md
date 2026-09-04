# Palmare Advanced Android - V5BT

Wrapper Android V5BT con package `com.sentrapa.palmare.advanced`. L'app apre la
WebView in modalita kiosk e fornisce le integrazioni native richieste dal
frontend.

Tutti i flag Gradle Bluetooth sono `false` per default:
`cassaBluetoothLab`, `cassaBluetoothDiagnostics`,
`cassaBluetoothIdentity`, `cassaBluetoothDiscovery`,
`cassaBluetoothFailover`, `cassaBluetoothGattClient`,
`cassaBluetoothDirectServer`,
`cassaBluetoothPeerLink`, `cassaBluetoothDiagnosticBadge` e
`cassaBluetoothEnrollment`. Il master failover richiede insieme build Lab,
identity e discovery; la radio fallisce chiusa senza identita pronta, permessi
BLE, adapter attivo e classificazione `FULL_NODE`.

## Integrazioni native

- HTTPS LAN per l'origine configurata.
- Permessi WebView per microfono, fotocamera e geolocalizzazione.
- NFC con sessione attiva solo mentre il frontend ascolta `native:nfc`.
- Feedback aptico tramite `window.AmaliaNativeHaptics`.
- PTT sul canale principale con pressione prolungata di Volume Su.
- Ricezione radio nativa quando UI o schermo non sono attivi.
- Batteria letta localmente da Android e inviata direttamente alla WebView solo al cambio di
  percentuale o stato di carica.
- Telemetria batteria unidirezionale verso il server: un invio iniziale e poi uno ogni 120 secondi,
  senza invii aggiuntivi al cambio stato e senza polling dal frontend.
- Notifiche Android raggruppate e silenziose a UI aperta.

## Policy notifiche in background

- Chiamate cameriere, comande pronte e squilli palmare sono raggruppati per tipologia.
- Le notifiche generali visibili sono al massimo le ultime tre.
- Una raffica genera un solo suono e una sola vibrazione per tipologia.
- I segnali sono accodati e non si sovrappongono.
- Chiamate cameriere e comande pronte ancora attive vengono ricordate ogni 5 secondi.
- I messaggi FCM devono essere `data-only` per consentire all'app di applicare sempre
  filtro e raggruppamento. I payload FCM `notification` vengono rifiutati perche possono
  essere mostrati direttamente da Android prima del servizio applicativo.
- Ogni messaggio FCM deve dichiarare il dispositivo destinatario, `sessionStartedAt` e almeno
  uno tra ID utente e username. Tutti i valori devono coincidere esattamente con la sessione
  nativa corrente; campi assenti, notifiche precedenti al login e audience obsolete sono
  scartati senza suono, vibrazione o notifica Android.
- Anche l'ingresso JS `showNotification` applica lo stesso contratto. Il frontend corrente non
  lo invoca direttamente: polling e stream restano vincolati alla richiesta autenticata e alla
  generazione della sessione che li ha aperti.

## Build Windows

Prerequisiti: Android SDK 34 e Java 17 o 21.

```powershell
$env:JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
.\gradlew.bat :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

APK generato:

`app/build/outputs/apk/debug/app-debug.apk`

Questo percorso contiene sempre l'ultima variante compilata e puo quindi
essere sovrascritto da una build Lab. L'ultimo APK standard conservato si trova in
`../../../artifacts/Palmare-Advanced-v1.0.22-debug.apk`.

Build B5.4 Lab:

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

La variante certificata e
`../../../artifacts/Palmare-Advanced-v1.0.23-V5BT-Bluetooth-B5.4-Lab-debug.apk`.
`DirectServer` e `PeerLink` non vengono passati e restano falsi. Il client
B5.4 accetta soltanto Raspberry autorizzabili annunciati come raggiungibili,
apre la connessione GATT, valida esattamente servizio e caratteristiche e
negozia l'MTU. Non legge o scrive caratteristiche, non si sottoscrive a
notifiche, non esegue HELLO o autenticazione e non apre sessioni. Condivide il
package Advanced con la build standard.

Il file `local.properties` e specifico della macchina e non deve essere distribuito
come configurazione universale.
