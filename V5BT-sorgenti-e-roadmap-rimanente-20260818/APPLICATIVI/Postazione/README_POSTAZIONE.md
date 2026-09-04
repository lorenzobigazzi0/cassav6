# Postazione Advanced 2.0.17 - V5BT

Postazione Advanced e l'app Android landscape della copia V5BT per il frontend
operativo `/postazione/`. Usa il package
`com.sentrapa.postazione.advanced`, distinto dalle app V4, quindi puo essere
installata affiancata senza sostituirle.

La build standard mantiene tutti i flag Bluetooth disabilitati. La variante
B3 Lab e esplicitamente nominata e fallisce chiusa se identita, permessi o
capacita `FULL_NODE` non sono pronti.

## Architettura

- `web-frontend/`: sorgente Postazione derivato dalla baseline V4.6
  corrente.
- `android-app/`: shell Android mantenuta allineata alla baseline Palmare.
- Il task Gradle `syncBundledWebApp` copia `web-frontend/dist` in
  `app/src/main/assets/postazione`.
- La WebView mantiene l'origine HTTPS configurata e intercetta solo
  `/postazione`, servendo la UI dall'APK.
- API, SSE e WebSocket continuano a usare il server sulla stessa origine.
- La disponibilita del pulsante CAMERIERE e calcolata unicamente da React;
  i bridge legacy non modificano piu lo stato del controllo nel DOM.

L'identita nativa viene letta dalle chiavi canoniche della Postazione. Il
servizio batteria usa `postazione_device_uuid`; le notifiche native usano
utente, token, device e stazione solo dopo un login valido. Radio e polling non
partono senza un'identita completa.

## Build

```powershell
cd D:\cassav2\CASSAV4_V4.6_CURRENT\android\Postazione
.\build-postazione.ps1
```

Output:

```text
D:\cassav2\CASSAV4_V5BT\APPLICATIVI\Postazione\Postazione-Advanced-2.0.17-debug.apk
```

La standard `2.0.17` ha superato 124 test JVM, lint, verifica DEX dei flag
disabilitati e firma APK v2. SHA-256:
`6ae7e6eda2a21f16680f867df30fbf3f50bc1f6bde49326e14abed34cd6cdf3d`.

La variante B3 Lab corrente e
`Postazione-Advanced-2.0.17-V5BT-Bluetooth-B3-Lab-debug.apk`. Abilita Lab,
diagnostica, identita, discovery, enrollment, failover e badge diagnostico
read-only. `DirectServer` e `PeerLink` restano falsi: non apre GATT e non crea
sessioni. SHA-256:
`67442280965b731fb3f0c5f5c31be07dcf1459849e1cb2fae733e65a9cc371a8`.
Resta non installata e non chiude i gate fisici B1/B2/B3.

Le varianti enrollment `2.0.16` e B2 `2.0.15` restano disponibili come
artefatti storici. Condividono il package Advanced della standard e quindi si
sostituiscono tra loro sul dispositivo; non sostituiscono l'app Postazione V4.

Installazione su un device ADB autorizzato:

```powershell
.\build-postazione.ps1 -Install -DeviceSerial R9WT50ZN5VZ
```

URL iniziale: `https://192.168.0.28:5280/postazione/`.

## Provenienza

La vecchia sorgente `C:\Users\utente\Desktop\Web2_orizzontale` e rimasta
invariata come riferimento di rollback. Dalla vecchia app e stato mantenuto
l'orientamento; application ID, runtime, permessi, trust HTTPS e servizi nativi
provengono dalla shell Palmare validata.

## Compatibilita P5.4 2026-07-16

La release `2.0.13` incorpora il frontend Postazione V4.6 invariato rispetto al contratto
applicativo e certifica la ricompilazione contro lo stack backend P5.4.

APK: `Postazione-2.0.13-debug.apk`, SHA-256
`765B0EC7CC0545F6AA9BD44E90F0D37432D95F9F4139C5801433A390B40ABED5`.

## Allineamento frontend corrente 2026-07-17

Il frontend incorporato coincide byte per byte con la Postazione V4.6 corrente. La release
`2.0.14` identifica la nuova build Android mantenendo package e orientamento landscape.

APK: `Postazione-2.0.14-debug.apk`, SHA-256
`D44C2F28FA7ED888A6BACA04F10A6ABCF1AF1487E9CC5D8496AB72CCC637739F`.

Installazione verificata su SM-T503 `R9WT50ZN5VZ`: `versionCode 16`,
`versionName 2.0.14`.
