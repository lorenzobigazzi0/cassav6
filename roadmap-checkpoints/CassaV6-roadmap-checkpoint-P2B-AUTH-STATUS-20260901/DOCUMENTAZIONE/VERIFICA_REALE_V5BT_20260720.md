# Verifica reale Cassa V5BT

Data: 2026-07-20

## Ambito

Questa verifica copre importazione del pacchetto V5BT, build dei frontend,
build degli APK, avvio isolato sul Raspberry e smoke test reale di Palmare
contro il backend V5BT. Postazione deve essere verificata esclusivamente sul
tablet dedicato.

## Provenienza

Workspace autorevole:

```text
D:\cassav2\CASSAV5BT_CURRENT\cassa V5BT
```

Archivio importato:

```text
C:\Users\utente\Downloads\Cassa-V5BT-portabile-sorgenti-server-db-20260720.zip
SHA-256 B84EEFE34A29D8D2840ABBF022893831FA3587C417B24332AA47E194164FD7FF
```

Bundle frontend trasferito al Raspberry:

```text
SHA-256 E9E3E144112B080EABDDFFC055C358DF0CFA8FF1CA019AFE936C16524355BC07
```

## Correzione del runtime

Il launcher incluso nel pacchetto assumeva un binario Node x64 e non poteva
avviarsi sul Raspberry ARM64. E stato aggiunto `tools/v5bt-node-runtime.sh` e
sono stati allineati:

- `start-v5bt.sh`;
- `stop-v5bt.sh`;
- `database/provision-cassa-v5bt.sh`;
- `tests/v5bt-isolation.test.mjs`.

Il resolver seleziona il runtime in base a `process.arch` e rifiuta override
relativi o incompatibili.

## Runtime Raspberry

Host:

```text
192.168.0.67
```

Directory:

```text
/home/admin/cassav5bt-current/cassa V5BT
```

Servizi verificati:

| Servizio | Porta | Esito |
| --- | ---: | --- |
| Frontend HTTPS | 5380 | attivo |
| Backend API | 5381 | attivo |
| Batteria | 8865 | attivo |
| Fiscale simulato | 9390 | attivo |
| Cassa automatica simulata | 9391 | attivo |
| Realtime dedicato | 5382 | riservato, non avviato |
| API worker | 5383 | riservato, non avviato |

URL LAN verificati:

```text
https://192.168.0.67:5380/mobile/
https://192.168.0.67:5380/postazione/
```

L'health check backend restituisce `ok=true`, `database.ok=true` e
`database.mode=mysql`.

Il database V5BT usa lo schema isolato `cassa_v5bt` e l'utente
`cassa_v5bt_app@127.0.0.1`. Il provisioning ha verificato 480 tabelle di
produzione piu la tabella marker V5BT. La V4 continua a rispondere sulla porta
5280 e non e stata modificata.

L'avvio corrente e monolitico. I processi realtime e order worker dedicati non
sono dichiarati attivi.

## Build e test

Frontend Mobile:

- typecheck: superato;
- build: superata;
- output: 95 file;
- suite completa: 456 test superati su 468, 12 falliti.

I 12 test residui sono in prevalenza controlli statici legati alla forma del
sorgente e budget gia non allineati; restano inoltre un caso di mapping errore
QR e una fixture guida mancante. La suite completa non e quindi dichiarata
verde, anche se typecheck e build sono riusciti.

Frontend Postazione:

- build: superata;
- output: 47 file;
- restano warning runtime legacy gia presenti.

Android Palmare Advanced:

- 131 test JVM superati;
- lint: 0 errori, 23 warning;
- assemble debug: superato.

Android Postazione Advanced:

- 125 test JVM superati;
- lint: superato;
- assemble debug: superato.

Harness Bluetooth B3:

- self-test: 39/39;
- runner: 28/28;
- dry-run: superato.

Questi risultati non sostituiscono il gate B3 fisico a due dispositivi.

Gate di isolamento V5BT:

- Raspberry ARM64: 8/8 superati;
- Windows: 6/8 superati, con i due test POSIX non eseguibili perche verificano
  il bit Unix `executable` e invocano `/bin/bash`.

Il risultato autorevole per gli script di deploy Linux e quello Raspberry.

## APK standard verificati

Palmare Advanced:

```text
Package:     com.sentrapa.palmare.advanced
Versione:    1.0.22
VersionCode: 23
SHA-256:     0D018ED25E3D16BE5FAF169366EC68DA379A519A565A7A91FDE6421F523C7DF4
```

Postazione Advanced:

```text
Package:     com.sentrapa.postazione.advanced
Versione:    2.0.17
VersionCode: 19
SHA-256:     62514AB462D426A38D182F724D34C3846A196D5EF72BE2D16A450E1F53B927D3
```

## APK Lab Bluetooth B3 verificati

Palmare Advanced Lab:

```text
Package:     com.sentrapa.palmare.advanced
Versione:    1.0.22
VersionCode: 23
SHA-256:     0791665FF598E523AEBFA6EA724ACAA86E2EEC08B956E08F7EE5095241BD8D34
```

Postazione Advanced Lab:

```text
Package:     com.sentrapa.postazione.advanced
Versione:    2.0.17
VersionCode: 19
SHA-256:     019032F800393063E6F8EB4937AD79ED7D9CC7C35F41A2C0A49590DB677279C4
```

Firma debug comune:

```text
SHA-256 DFE2671D663514CD3D4AAB9055EB0D311743189AC7429A887292D9FEF0F8E34F
```

## Prova Android reale

Dispositivo fisico collegato:

```text
Seriale: RFGYA0ZAGFW
Modello: Samsung SM-A165F
Android: 16
Schermo: 1080x2340
```

Sul telefono e installata esclusivamente Palmare Advanced. Postazione Advanced
e stata rimossa e non deve essere reinstallata su questo dispositivo. Per
Palmare risultano concessi i permessi CAMERA, RECORD_AUDIO e
POST_NOTIFICATIONS.

URL salvati:

```text
Palmare: https://192.168.0.67:5380/mobile/
```

Esiti osservati:

- Palmare autenticato e dati sala Pedana caricati;
- pagina Radio in stato `Radio connessa`, quindi WebSocket autenticato attivo;
- enrollment Bluetooth fisico completato con stato `READY`;
- identita Android Keystore completata con stato `READY`;
- scanner e advertiser BLE attivi, senza errori o payload invalidi;
- registro Raspberry con un device e token monouso consumato;
- connessioni TLS Android verso `192.168.0.67:5380` visibili sul Raspberry;
- nessun crash Android o errore applicativo fatale osservato nello smoke test.

La Postazione non viene validata su smartphone. Il relativo APK resta un
artefatto di build e sara installato solo sul tablet `SM-T503`.

Evidenze:

```text
DOCUMENTAZIONE/evidenze/20260720/v5bt-palmare-live2.png
DOCUMENTAZIONE/evidenze/20260720/v5bt-radio-final2.png
DOCUMENTAZIONE/evidenze/20260720/v5bt-palmare-enrolled-ready.png
ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/physical/v5bt-palmare-b2-20260720-ready.json
```

## Correzione Android Keystore Samsung

Sul Samsung `SM-A165F` la chiave Ed25519 veniva generata correttamente nel TEE,
ma `KeyStore.getEntry()` falliva perche il provider esponeva nomi algoritmo
equivalenti ma diversi tra chiave privata e certificato (`Ed25519` e `EdDSA`).

`DeviceIdentityManager` di Palmare e Postazione ora:

- legge separatamente la chiave privata con `KeyStore.getKey()`;
- legge la chiave pubblica con `KeyStore.getCertificate()`;
- richiede `KeyInfo` usando prima l'algoritmo dichiarato dalla chiave;
- conserva i fallback Android Keystore `Ed25519` ed `EC`;
- mantiene i controlli fail-closed su esportabilita, SPKI, origine, dimensione,
  scopi, digest e firma;
- registra una sola volta per processo e motivo i codici diagnostici non
  sensibili quando una chiave viene rifiutata.

La correzione e stata verificata fisicamente su Palmare: zero warning
`V5BTIdentity`, enrollment `READY` e identita recuperata correttamente dopo il
riavvio dell'app. Postazione passa test, lint e build, ma resta da verificare
fisicamente sul tablet dedicato.

Il gate B2 a nodo singolo ha prodotto:

```text
Preflight:             PASS
Readiness BLE:         READY
Radio active:          true
Scan windows started:  3
Scan failures:         0
Advertising failures:  0
Invalid payloads:      0
Reciprocal peer:       PENDING
```

Lo stato `PENDING` e atteso perche non era collegato un secondo nodo. Al termine
il QR consumato e stato rimosso, il servizio enrollment e stato arrestato e la
porta `9443` e stata chiusa. Il servizio resta disabilitato all'avvio.

## HTTPS

Il certificato del frontend ha CN `192.168.0.67` e SAN per `192.168.0.67`,
`127.0.0.1` e `localhost`; e valido dal 2026-07-20 al 2028-10-22.

Android non considera la CA attendibile a livello di sistema e Chromium
registra `net_error -202`. Le app consentono il certificato solo per
l'origine LAN privata configurata tramite `LocalHttpsTrust`, quindi il flusso
funziona, ma non equivale a una CA installata e attendibile dal sistema.

Debito di sicurezza: i client nativi usano ancora un trust permissivo per IP
privati. Prima di una distribuzione definitiva e raccomandato installare la CA
locale sui dispositivi o introdurre pinning CA/SPKI.

## Gate ancora aperti

- tablet Postazione richiesto `R9WT50ZN5VZ` non collegato;
- prova grafica reale Postazione su tablet orizzontale non eseguita;
- prova Bluetooth B3 reciproca a due dispositivi non eseguita;
- endurance B3 da 3600 secondi non eseguita;
- suite Mobile completa ancora con 12 test falliti;
- firma Android release non configurata;
- hardening della fiducia HTTPS ancora da completare;
- worker realtime/order dedicati non avviati nel profilo corrente.

## Avanzamento Bluetooth successivo

Il core B4.1 del nodo Raspberry e stato implementato e verificato dopo questa
validazione iniziale. Il report specifico e:

```text
ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/B4_RASPBERRY_BLUEZ_NODE_CORE_20260720.md
```

Il risultato software e `PASS`; il gate fisico B4 resta `PENDING`.
