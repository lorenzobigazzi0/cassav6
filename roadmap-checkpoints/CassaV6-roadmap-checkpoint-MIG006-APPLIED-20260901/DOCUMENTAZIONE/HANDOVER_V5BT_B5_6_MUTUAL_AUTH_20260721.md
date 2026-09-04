# Handover Cassa V5BT B5.6 mutual auth

Data: 2026-07-21

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

- il gate B5.6 Android-Raspberry e PASS fisico separato su due Palmari Android
  API 36;
- ogni prova ha completato un HELLO, un client proof verificato, un server
  proof verificato e un finish verificato;
- ogni prova ha raggiunto `AUTHENTICATED` una sola volta, con zero failure;
- ciascun cleanup ha riportato a zero le sessioni autenticate e ha rimosso le
  risorse GATT temporanee;
- le caratteristiche business sono rimaste fail-closed;
- la Cassa V4 non e stata modificata durante le prove.

Il tablet non ha partecipato a B5.6. La build Postazione e stata prodotta, ma
questo passaggio non dichiara alcuna installazione o certificazione fisica su
tablet.

## Evidenze redatte

Le due evidenze server non contengono seriali ADB, indirizzi Bluetooth, NodeId,
certificateId, sessionId, token, chiavi, materiale crittografico o payload:

```text
ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/
  reports/physical/v5bt-b5-6-phone-a-20260721.json
ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/
  reports/physical/v5bt-b5-6-phone-b-20260721.json
ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/
  reports/physical/v5bt-b5-6-enrollment-discovery-two-palmari-20260721.json
```

In entrambe le evidenze il verdetto e `PASS`, con autenticazione reciproca
completa, una sessione autenticata prima del cleanup, zero dopo il cleanup e
zero failure.

## APK finali

Palmare Advanced:

```text
APPLICATIVI/Palmare/android-app/app/build/outputs/apk/debug/app-debug.apk
Package: com.sentrapa.palmare.advanced
Version: 1.0.27 (28)
Mutual auth: enabled
Enrollment: disabled
SHA-256: 395007BFDCB7A7739A02BF7C6109AE8A3A6A6062EC7B9131FD0B6AE3F388B28F
```

Postazione Advanced:

```text
APPLICATIVI/Postazione/android-app/app/build/outputs/apk/debug/app-debug.apk
Package: com.sentrapa.postazione.advanced
Version: 2.0.19 (21)
Mutual auth: enabled
Enrollment: disabled
SHA-256: 1471AB0E56D9E3DA9636388D2EC9984A29504A39A1EBA2D03122F317C5C81AA8
```

Entrambi gli APK mantengono Direct Server e Peer Link disattivati, sono firmati
con il certificato Android Debug e verificano con APK Signature Scheme v2.
L'APK Palmare installato sui due telefoni coincide con lo SHA-256 sopra.
Palmare va installata soltanto sugli smartphone; Postazione e riservata ai
tablet.

## Enrollment e Raspberry

L'enrollment e stato aperto soltanto per il provisioning temporaneo dei due
Palmari. Al termine della prova l'endpoint e spento e
`cassav5bt-bluetooth-enrollment.service` e `inactive` e `disabled`. Token,
wrapper di enrollment, chiavi e certificati privati non fanno parte delle
evidenze o dei pacchetti sorgente.

Il runtime B5.6 sul Raspberry e uno staging di laboratorio versionato e non ha
una unita persistente abilitata. Al termine dei run l'adapter e rimasto acceso,
non in discovery e non discoverable; le applicazioni GATT e gli advertiser
temporanei sono stati rimossi. I servizi Cassa V4 sono rimasti attivi.

Lo staging verificato e conservato separatamente dalla Cassa V4:

```text
Runtime: /opt/cassav5bt-bluetooth-lab/releases/20260721-b5-6
Archivio: /home/admin/cassav5bt-b5-6-20260721/cassav5bt-b5-6-runtime-20260721.tar.gz
SHA-256: F6C22F9F0CED9A783212EBDE3D6CF8F82B5B5BF63D55B90E6FF56A6DEC58A6A5
```

L'archivio non contiene `node_modules`, cache o copertura test. Il codice
JavaScript compilato in `raspberry/dist` resta incluso perche necessario
all'esecuzione diretta del runtime sul Raspberry.

## Confine B5.6

B5.6 autentica reciprocamente le identita enrollate e si ferma nello stato
`AUTHENTICATED`. Non deriva session key, non avvia heartbeat, non raggiunge
`ACTIVE` e non abilita frame cifrati o traffico ordini. Il gate B5 da 100
sessioni resta `PENDING`.

## Prossimo incremento

Il prossimo passo e B5.7: derivazione e binding della session key dopo mutual
auth. Deve mantenere fail-closed replay, mismatch di identita, callback
duplicate, timeout e disconnect. Heartbeat, transizione `ACTIVE`, traffico
business e gate delle 100 sessioni restano incrementi successivi separati.

## Ripristino su un altro PC

1. Estrarre il pacchetto in un percorso corto.
2. Installare Node.js, JDK 17 e Android SDK 34 o superiore.
3. Eseguire `npm ci` nei progetti Node interessati.
4. Rigenerare `local.properties` per l'Android SDK locale.
5. Ricompilare gli APK o verificare gli hash soltanto dopo averli promossi tra
   gli artefatti immutabili.
6. Leggere `README_V5BT.md`, `DOCUMENTAZIONE/WORKSPACE_ATTIVA.md` e questo
   handover prima di modificare o distribuire.

Cache, `node_modules`, build Gradle, stato `.runtime` e report temporanei con
identificatori non sono necessari per riprendere lo sviluppo. Certificati
privati, chiavi, file `.env` reali e configurazioni restricted non devono
essere distribuiti nello ZIP sorgente.
