# Fase G5 - Android reale

Data: 2026-07-01

## Obiettivo

Validare con build Android reale la parte nativa della webview dopo le modifiche realtime, in particolare:

- `NativeNotificationPoller` attivo solo quando l'app non e' in foreground.
- polling nativo a 20 secondi.
- generazione APK reale con Gradle.
- gate lint Android senza errori bloccanti.

## Toolchain usata

- Java: OpenJDK 17.
- Gradle: 8.2 locale in `/home/sentrapa/.local/cassav4-android-toolchain/gradle/gradle-8.2`.
- Android SDK locale: `/home/sentrapa/.local/cassav4-android-toolchain/android-sdk`.
- SDK installati:
  - `platform-tools` 37.0.0
  - `platforms;android-34`
  - `build-tools;34.0.0`

## Comandi eseguiti

Dal progetto Android:

```bash
cd /home/sentrapa/Desktop/sistemacassav4/estratto/v4.0.2-20260629-181421/android-webview-app-source
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export ANDROID_HOME=/home/sentrapa/.local/cassav4-android-toolchain/android-sdk
export ANDROID_SDK_ROOT=/home/sentrapa/.local/cassav4-android-toolchain/android-sdk
/home/sentrapa/.local/cassav4-android-toolchain/gradle/gradle-8.2/bin/gradle --no-daemon :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

Risultato finale:

```text
BUILD SUCCESSFUL in 1m 29s
42 actionable tasks: 16 executed, 26 up-to-date
```

`testDebugUnitTest` risulta `NO-SOURCE`, quindi non ci sono unit test Android locali da eseguire in questo modulo.

## APK generato

Percorso:

```text
/home/sentrapa/Desktop/sistemacassav4/estratto/v4.0.2-20260629-181421/android-webview-app-source/app/build/outputs/apk/debug/app-debug.apk
```

Dimensione:

```text
14M
```

SHA256:

```text
4d93bd9e327024b03bf47e90dbe157eb9de00034a1495af4a291efbb90373511
```

Verifica archivio:

```text
No errors detected in compressed data of app/build/outputs/apk/debug/app-debug.apk.
```

## Correzioni lint applicate

Il primo giro di lint aveva 4 errori bloccanti. Sono stati corretti cosi':

- `NotificationHelper.kt`: aggiunto controllo runtime di `POST_NOTIFICATIONS` prima di chiamare `NotificationManagerCompat.notify`.
- `NativeHapticsBridge.kt`: aggiunte annotazioni `@RequiresApi` sui metodi che usano API 26 e API 31.
- `themes.xml`: spostato `android:windowLayoutInDisplayCutoutMode` in `values-v27/themes.xml`.

Il lint finale chiude con:

```text
0 errors, 16 warnings
```

Le warning residue non bloccano il gate G5. Le principali aree da trattare in una fase successiva sono: policy batteria Android, dipendenze Android non aggiornate, trust manager/SSL locale, wakelock senza timeout, icona monochrome mancante e check SDK obsoleti.

## Validazione NativeNotificationPoller

Validazione statica completata sul sorgente Android:

- `NativeNotificationPoller.shouldRun()` richiede `canRun() && !foreground`.
- `updateForeground()` richiama `refreshRunningState()`.
- il loop di polling esegue `pollOnce()` e poi `delay(POLL_INTERVAL_MS)`.
- `pollOnce()` esce se l'app e' in foreground.
- `POLL_INTERVAL_MS = 20_000L`.
- `AlwaysOnService` crea il poller nativo e aggiorna il foreground state tramite listener.

Esito: G5 completata. Il prossimo step della roadmap e' la fase H, idempotency e outbox centralizzati.
