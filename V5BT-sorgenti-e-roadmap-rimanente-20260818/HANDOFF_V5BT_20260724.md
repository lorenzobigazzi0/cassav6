# Handoff operativo V5BT

Ultimo aggiornamento: 2026-08-18, Europe/Rome.

## Regole di continuita

- Il prodotto si chiama esclusivamente **V5BT** in messaggi, artefatti nuovi e deploy.
- Al termine di ogni messaggio all'utente aggiungere esattamente:
  `Avanzamento roadmap complessiva: **49%**`
- Non modificare o ripristinare materiale estraneo al lavoro corrente.
- Le copie canoniche correnti sono indicate sotto. Prima di sincronizzare interi alberi usare sempre un dry-run.
- I bridge nativi Android per WebView, NFC, aptica, notifiche e Bluetooth sono contratti di piattaforma e non vanno confusi con i vecchi shim JavaScript.

## Incremento Applicativo Precedente

Ambito gia implementato localmente, con deploy fisico da verificare alla
riconnessione:

1. Rimuovere tutti i bridge JavaScript residui dalla Postazione.
2. Eliminare dal Palmare il fallback HTTP automatico.
3. Ricompilare, verificare, distribuire la Postazione sul Raspberry e aggiornare il Palmare collegato.

## Workspace e componenti canonici

- Root workspace: `/home/sentrapa/cassa V5BT`
- Postazione React canonica: `APPLICATIVI/Postazione/web-frontend`
- Copia server Postazione: `SORGENTE_SISTEMA/postazione`
- Copia compilata Postazione: `WEBAPP_COMPILATA/postazione`
- Wrapper Android Postazione: `APPLICATIVI/Postazione/android-app`
- Palmare React canonico: `APPLICATIVI/Palmare/web-frontend`
- Copia server Palmare: `SORGENTE_SISTEMA/mobile-frontend`
- Wrapper Android Palmare: `APPLICATIVI/Palmare/android-app`
- Roadmap Bluetooth importata: `ROADMAP_BLUETOOTH/.../roadmap/MASTER_ROADMAP.md`
- Avanzamento roadmap dichiarato e da mantenere nei messaggi: **49%**.

## Modifiche Postazione gia applicate

### Ownership React

Il comportamento prima distribuito tra shim globali e React e stato trasferito in React/moduli puri.

File principali:

- `APPLICATIVI/Postazione/web-frontend/src/App.jsx`
- `APPLICATIVI/Postazione/web-frontend/src/stationRuntime.js`
- `APPLICATIVI/Postazione/web-frontend/css/layout.css`
- `APPLICATIVI/Postazione/web-frontend/public/assets/postazione-order-sound.js`
- `APPLICATIVI/Postazione/web-frontend/test/stationRuntime.test.mjs`
- `APPLICATIVI/Postazione/web-frontend/test/postazioneReactOwnership.test.mjs`
- `SORGENTE_SISTEMA/postazione/src/postazioneSyncCoordinator.js`
- `SORGENTE_SISTEMA/postazione/test/postazioneSyncCoordinator.test.mjs`

Responsabilita ora gestite in React:

- autenticazione centralizzata per le API con `Authorization`, `X-User-Id` e `X-Device-Uuid`;
- cancellazione delle richieste in volo e guardia di generazione sessione al logout;
- heartbeat della postazione legato alla sessione autenticata;
- elenco dinamico delle postazioni configurate;
- sessioni reali e occupazione lette da `/api/integration/stations/active`;
- login Postazione in due fasi: prima credenziali, poi scelta obbligatoria da
  allowlist utente con associazione atomica lato server;
- pausa con trasferimento a postazione reale o coda virtuale;
- conferma logout tramite modale React;
- supporto per ordini provenienti dalla cassa con `station_support_request`;
- label tavolo esplicita/logica;
- timer sempre in formato `HH:MM:SS`;
- storico classificato e in sola lettura;
- retry idempotente delle azioni `Pronta`;
- aggiornamento impostazioni in background tramite `runSync`, senza banner persistente o reload;
- coordinatore anti-tempesta della sincronizzazione completa: una sola sync
  attiva, massimo una trailing per raffica e conservazione dei trigger arrivati
  durante la trailing;
- lettura layout single-flight per evitare richieste duplicate concorrenti;
- cancellazione del coordinatore e invalidazione del lavoro al logout e
  all'unmount.

### Shim web eliminati

Da `index.html` e `public/assets` sono stati rimossi tutti i vecchi script di correzione, inclusi:

- tutti i file `postazione-*-bridge.js`;
- `frontend-hot-fetch-cache.js`;
- guard, fix e bootstrap globali per API, login/logout, modali, storico e stazioni;
- wrapper globali di `window.fetch`;
- auto-next, auto-print, print fallback, support routing e settings live sync globali;
- pannello cameriere, tastiera modale e correttivi catalogo non piu necessari.

Gli unici asset JavaScript esterni intenzionalmente conservati sono:

- `postazione-disable-context-menu.js`
- `postazione-order-sound.js`
- `postazione-apericena-summary.js`

La query cache di `postazione-disable-context-menu.js` e stata rinominata in `v=20260724-react-runtime`, senza residui nominali del vecchio sistema.

### Test Postazione

- Test locali in `APPLICATIVI/Postazione/web-frontend`: **17/17 passati**.
- Test locali in `SORGENTE_SISTEMA/postazione`: **25/25 passati**.
- Build Vite di entrambe le copie: **riuscita**.
- Bundle canonico precedente: `assets/index-BbPxCy_f.js`; bundle sorgente
  aggiornato: `assets/index-BkgQmgfo.js`; CSS comune:
  `assets/index-Dq6PK1rV.css`.
- Test trasversali cassa aggiornati alla ownership React: **34/34 passati**.

Test trasversali aggiornati:

- `SORGENTE_SISTEMA/cassa-frontend/frontend-tests/postazione-bridges.test.mjs`
- `SORGENTE_SISTEMA/cassa-frontend/frontend-tests/bridge-hardening.test.mjs`
- `SORGENTE_SISTEMA/cassa-frontend/frontend-tests/postazione-cancelled-ui.test.mjs`
- `tests/v5bt-isolation.test.mjs`

Sono stati rimossi cinque vecchi test locali che eseguivano direttamente gli shim e sostituiti con test sui contratti React e sui moduli di dominio.

### Copie gia riallineate

- `APPLICATIVI/Postazione/web-frontend`
- `SORGENTE_SISTEMA/postazione`
- `WEBAPP_COMPILATA/postazione`

In questi tre alberi non risultano file web `*bridge*.js`.

## Modifiche Palmare gia applicate

### Trasporto nativo

File modificati:

- `APPLICATIVI/Palmare/android-app/app/src/main/java/com/sentrapa/webkiosk/NativeNotificationPoller.kt`
- `APPLICATIVI/Palmare/android-app/app/src/main/java/com/sentrapa/webkiosk/NativeBackgroundRadioReceiver.kt`
- `APPLICATIVI/Palmare/android-app/app/src/test/java/com/sentrapa/webkiosk/NativeNotificationTransportTest.kt`
- `APPLICATIVI/Palmare/android-app/app/build.gradle.kts`

Comportamento attuale:

- una URL configurata in HTTPS produce un solo candidato API HTTPS sulla stessa origine;
- la radio usa la stessa origine e converte HTTPS in WSS;
- non viene piu costruito automaticamente un candidato HTTP sulla porta backend;
- una configurazione esplicitamente HTTP resta HTTP, ma non genera altri fallback;
- il reporter batteria su porta LAN `8865` e separato e non e stato modificato.

Versione Palmare preparata:

- `versionName=1.0.36`
- `versionCode=37`
- package: `com.sentrapa.palmare.advanced`

Test mirato `NativeNotificationTransportTest`: **3/3 passati**.

### Vecchio fallback frontend eliminato

Il file archiviato `mobile-backend-connection-bridge.js`, che conteneva ancora la selezione automatica di host/porta HTTP, e stato eliminato da:

- `APPLICATIVI/Palmare/web-frontend/legacy-mobile-assets/assets`
- `SORGENTE_SISTEMA/mobile-frontend/legacy-mobile-assets/assets`

Sono stati aggiornati documentazione e test statici in entrambe le copie:

- `tests/static/mobileLegacyBridgeAssets.test.ts`
- `tests/static/v1BridgeNativeMigration.test.ts`
- `docs/mobile-frontend-v2/V1_BRIDGE_NATIVE_IMPORT.md`

Verifica mirata frontend Palmare: **3/3 test passati in entrambe le copie**.

## Versione Postazione Android

- `versionName=2.0.22`
- `versionCode=24`
- package: `com.sentrapa.postazione.advanced`

La build Gradle esegue `syncBundledWebApp` prima di `preBuild`; questa task usa `Sync`, quindi elimina dagli asset Android le vecchie copie non piu presenti nel nuovo `dist`.

## Build e artefatti finali

Entrambe le build complete sono terminate con successo usando:

```bash
JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64 \
ANDROID_HOME=/home/sentrapa/.local/v5bt-android-toolchain/android-sdk \
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Postazione:

- pipeline Gradle: **SUCCESS** in 9m08s;
- test Android: **176/176**, zero failure/error;
- lint: zero errori, 22 warning e 1 informazione;
- APK: `artifacts/Postazione-Advanced-v2.0.22-V5BT-No-Web-Bridges-debug.apk`;
- SHA-256: `be297b3223fcbff45ff68245ab049a8c37fc83943376dd4a610d8cd82cc18769`;
- scansione sorgente asset, intermedi, compressed assets e APK: zero shim web;
- l'HTML nell'APK carica solo il bundle React e i tre asset esterni ammessi.

Palmare:

- pipeline Gradle normale: **SUCCESS** in 3m49s;
- test Android: **183/183**, zero failure/error;
- lint: zero errori, 23 warning e 1 informazione;
- APK: `artifacts/Palmare-Advanced-v1.0.36-V5BT-No-HTTP-Fallback-debug.apk`;
- SHA-256: `a1f10e89f0d91be57fe240b9f6295f7c28895448bda14952fd5bc0e5630d5b30`;
- tutti i flag Lab e Bluetooth diagnostici sono disattivati;
- scansione di tutti i DEX e degli asset: nessun literal `5381` e nessun candidato HTTP automatico.

I checksum sono registrati e verificati in:

- `artifacts/V5BT_ADVANCED_APK_SHA256SUMS`
- `artifacts/SHA256SUMS`

## Verifiche ancora da chiudere

1. Sincronizzare il nuovo `SORGENTE_SISTEMA/postazione/dist` sul Raspberry.
2. Riavviare/verificare `cassav5bt.service` e controllare `/postazione/` e `/api/health`.
3. Installare il Palmare `1.0.36` sul device ADB e verificare `versionName/versionCode`.

Non tentare installazione Postazione sullo smartphone attuale: il package Postazione non era installato e il device rilevato e il Palmare.

## Ultimo Deploy Noto Da Rivalidare

- Host corrente: `192.168.0.67`
- SSH: `admin`
- Password fornita dall'utente: `admin`
- Root remoto: `/home/admin/cassav5bt-current/cassa V5BT`
- Service: `cassav5bt.service`
- Stato all'ultimo audit: active, enabled.
- Dist Postazione servito: `/home/admin/cassav5bt-current/cassa V5BT/SORGENTE_SISTEMA/postazione/dist`
- URL Postazione: `https://192.168.0.67:5380/postazione/`
- Health previsto: `https://192.168.0.67:5380/api/health`

Attenzione: il Raspberry serviva ancora il vecchio dist con gli shim all'ultimo audit riuscito. Subito prima del deploy `192.168.0.67` e diventato irraggiungibile: ping, SSH e porta `5380` non rispondono. Il deploy remoto resta obbligatorio per rendere effettiva la rimozione sulla Postazione web.

Procedura consigliata:

1. Creare una copia timestampata del `dist` remoto.
2. Usare `rsync -a --delete` dal nuovo `SORGENTE_SISTEMA/postazione/dist/` al dist remoto.
3. Riavviare il servizio solo dopo la sincronizzazione.
4. Verificare con `curl -k` che l'HTML remoto carichi solo i tre asset esterni ammessi.
5. Cercare da SSH eventuali `postazione-*-bridge.js` nel dist servito.

## Device Android

ADB:

- binario: `/home/sentrapa/.local/v5bt-android-toolchain/android-sdk/platform-tools/adb`
- device rilevato: `192.168.0.73:5555`
- modello: Samsung `SM_A165F`

Al momento dell'ultimo tentativo il device e scomparso da `adb devices` e non compare neppure su USB. Prima del deploy risultava collegato via ADB wireless.

Stato package all'ultimo audit:

- Palmare Advanced installato: `com.sentrapa.palmare.advanced`, `1.0.35`, code `36`;
- Postazione Advanced non installata sul device;
- esistono due vecchi package distinti, ma non rimuoverli senza una richiesta esplicita in questo passo.

Installazione prevista:

```bash
/home/sentrapa/.local/v5bt-android-toolchain/android-sdk/platform-tools/adb \
  -s 192.168.0.73:5555 install -r <apk-palmare-1.0.36>
```

Dopo l'installazione verificare con `dumpsys package com.sentrapa.palmare.advanced`. Non e necessario portare l'app in primo piano.

## Bridge nativi da conservare

Questi file/classi sono necessari e non sono shim web:

- `notifications/NativeNotificationBridge.kt`
- `NativeNfcController.kt` / `NativeNfcBridge`
- `NativeHapticsBridge.kt`
- `bluetooth/NativeBluetoothCapabilityBridge.kt`
- `bluetooth/BluetoothFailoverUiBridge.kt`

I primi gestiscono sessione/notifiche, hardware NFC e aptica. I due Bluetooth sono condizionali alle feature V5BT.

## Contesto funzionale da non perdere

Richieste utente gia affrontate nel ciclo V5BT e da preservare durante i prossimi interventi:

- login Palmare con batteria e ora in alto, allineate alla top bar interna;
- logout che rimuove il device dalle disponibilita e interrompe notifiche/audio;
- reinoltro automatico delle comande se il cameriere destinatario non e piu online;
- best seller: massimo sette in alto con stella, tutti gli altri nell'ordine normale;
- nome tavolo a destra della X nella modale da pressione lunga;
- impostazioni fondo cassa automatico e statistiche POS solo nel frontend `/impostazioni`, non sul Palmare;
- quadro pagamenti aggiornato in background;
- configurazione tavoli, prodotti e sale mantenuta offline e riconciliata al ritorno online;
- banner `Configurazione aggiornata` non persistente;
- integrazioni reali fiscale, cassa automatica e stampa da mantenere abilitate secondo configurazione del sistema.

Le casistiche avanzate di riconciliazione offline per tavoli eliminati/prenotazioni cancellate restano da definire con l'utente; non inventare policy irreversibili.

## Criteri Residui Dell'Incremento Applicativo

- Zero shim JavaScript Postazione nel sorgente, nel dist, negli asset Android, negli intermedi, nell'APK e nel dist remoto servito.
- I soli bridge rimasti sono quelli nativi Android elencati sopra.
- Nessun fallback HTTP automatico del Palmare per API notifiche o radio.
- Test Postazione, test Palmare, lint Android e build APK tutti verdi.
- Raspberry riconnesso e nuovo dist verificato; controllo ancora pendente.
- Palmare collegato aggiornato a `1.0.36` code `37`.
- APK e checksum finali disponibili in `artifacts/`.

## Aggiornamento Autorevole 2026-08-04

Questa sezione supera le indicazioni operative precedenti relative a rete,
stato ADB e installazione Palmare, che restano nel documento soltanto come
cronologia.

Profilo di simulazione operativa offline:

- `v5bt-operations-30` supporta al massimo 25 Palmare e 5 Postazioni;
- ogni device avvia una azione ogni 3 secondi;
- ogni Palmare crea comande con gap alternato di 9 e 6 secondi, media target
  7,5 secondi e gate di accettazione fra 7 e 8 secondi;
- il full usa 200 azioni/device, 6.000 azioni e 2.000 comande; lo smoke usa 40
  azioni/device, 1.200 azioni e 400 comande; il micro usa 10 azioni/device,
  300 azioni e 100 comande;
- il catalogo include storno, spostamento tavolo e sala, cambio Tavoli/Banco
  tramite UI, pagamenti, stampa, notifiche, trasferimenti e le altre
  operazioni mobili non distruttive previste dal runner;
- stampanti, fiscale, cassa automatica e batteria sono esclusivamente mock
  loopback;
- BLE, ADB, Raspberry, UPS e hardware non sono emulati ne interrogati;
- annullamenti fiscali reali e altre azioni distruttive restano scenari
  separati e opt-in;
- il runbook autorevole e
  `SORGENTE_SISTEMA/cassa-frontend/V5BT_OPERATIONS_30_LOADTEST.md`.

Il profilo misura carico e comportamento applicativo. Non costituisce
evidenza fisica Bluetooth e non modifica il **49%** ufficiale.

Controlli anti-tempesta applicativi:

- il Palmare deduplica payload/refresh realtime dello stesso evento, esegue un
  solo refresh attivo e conserva soltanto l'ultimo trailing; dispose, logout e
  unmount annullano il contesto e scartano la coda;
- la Postazione esegue una sola sync completa con massimo una trailing per
  raffica, non perde i trigger successivi e usa single-flight per le letture
  layout concorrenti; logout e unmount cancellano la coda;
- il gate richiede zero burst anticipati, massimo 2 in-flight per device e 60
  globali, P95 azioni entro 3.000 ms, P95 comande entro 8.000 ms e massimo
  azione entro 30.000 ms;
- ogni GUI e ogni route calda layout/ordini hanno budget
  `10 + 2 * azioniPerDevice`; request failure, HTTP 5xx ed errori console
  devono essere zero;
- le comande persistite devono coincidere esattamente con il target per ogni
  Palmare, senza perdite o duplicati, e i retry della stessa comanda devono
  mantenere la stessa chiave idempotente.

La suite contratti della simulazione e **22/22 PASS**. Il prossimo gate e il
micro 25+5 da 300 azioni, attualmente `PENDING/NOT_RUN`: non dichiararlo PASS e
non procedere allo smoke finche il report reale non chiude ogni gate in verde.

Correzione e ricertificazione Palmare:

- `DEFAULT_SERVER_URL` punta a
  `https://192.168.1.79:5380/mobile/`;
- lo stesso URL gia configurato viene conservato;
- i precedenti default `192.168.0.67` e `192.168.1.182` vengono migrati al
  server corrente;
- Palmare Advanced Lab resta `1.0.36` code `37`, con SHA-256
  `ccfd96034ad798649e95e41ac5404aab6be7f804bba095003be59bb6f4c95587`;
- Postazione Advanced Lab resta `2.0.22` code `24`, con SHA-256
  `60cee3c61f8aeb1a3c7fa2302f78202b59d58ba20f9b4504f52922b02402214f`;
- entrambe le firme APK v2 sono valide;
- test Android `197/197` sul Palmare e `190/190` sulla Postazione;
- la build corretta e stata reinstallata sui due Palmare con
  `adb install -r -g`, senza uninstall, `pm clear`, cambio utente, nuova
  enrollment o cancellazione dati;
- l'inventario read-only post-fix e valido per i controlli Android,
  Raspberry, servizi, registry ed enrollment. Il riepilogo resta
  `INCOMPLETE` esclusivamente perche non e disponibile un probe dati UPS.

Esiti fisici post-fix:

- B0 supplementare: cattura conclusa `SUPPLEMENTAL_FAIL`, con gate formale
  `PENDING`. Su entrambi i Palmare sono PASS scan, advertising, concorrenza,
  coesistenza Wi-Fi/BLE e foreground/background; client e server GATT sono
  `FAIL/NOT_PROVEN`. Tutti i controlli di continuita sono PASS e il runner non
  produce un falso PASS;
- B1: le due identita preesistenti restano `READY` e coerenti con il registry;
- B2: il diagnostico schema 5 con isteresi ha eseguito `100/100` cicli fra due
  Palmare, con 95 `PASS`, 5 timeout e p95 19.145 ms contro il massimo di 8.000
  ms. Il p95 dopo la disponibilita dei reporter e 14.271 ms. Resta
  `NON_GATE_EVIDENCE/PENDING` e non sostituisce la coppia formale;
- inventario finale: entrambi i Palmare sono autenticati, `READY`, distinti e
  coerenti con il registry; il solo controllo incompleto resta il probe UPS;
- monitor Raspberry: `PASS` dopo 11.091.818 ms e 5.541 campioni, gap massimo
  3.490 ms, senza reboot o restart dei servizi;
- B3, B4, B5 e B6 non ricevono alcuna promozione da questa ricertificazione.

La policy radio arma una sola deadline di advertising LOW_LATENCY di 8 secondi
alla prima osservazione valida. Duplicati e update non la estendono; FAILOVER,
stop e cambio generazione la invalidano. La race di scheduling distingue
`ABORTED` da `FAILED`.

Verifica offline finale: Raspberry `196/196`, shared `124/124`, contratti
`22/22`, script roadmap `168 PASS` e `2 SKIP` storici, root `40/40`, advertiser
Python `7/7` con self-test `PASS`, Android `197/197` e `190/190`, coerenza build
`9/9`, matrice piu B3 `32/32`, B2 `34/34`, self-test B2 `128/128` e runner B0
`21/21`; zero failure nei blocchi rieseguiti.

La consegna sorgente corrente e
`V5BT-sorgenti-offline-20260804-b2-hysteresis.zip`; il
digest autorevole e nel file `.zip.sha256` affiancato. L'archivio del 3 agosto
resta soltanto storico e non va distribuito.

Report pubblico:
`ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/V5BT_PALMARE_LAB_RECERTIFICATION_20260804.md`.
Confronto radio:
`ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/V5BT_B2_RADIO_HYSTERESIS_20260804.md`.
L'avanzamento ufficiale resta **49%**.

## Aggiornamento Autorevole 2026-08-03

Il Raspberry e due telefoni Android sono raggiungibili. I due telefoni restano
Palmare Advanced; la Postazione certificata resta il tablet previsto, che non
e collegato. La percentuale ufficiale resta **49%** perche nessun gate fisico
formale e stato promosso.

Ripresa fisica eseguita in modo conservativo:

- inventario privato e report redatto acquisiti in sola lettura;
- rollback preinstallazione salvato privatamente per entrambi i Palmare;
- build Lab Palmare `1.0.36` code `37` installata con `adb install -r -g` su
  entrambi, senza uninstall, `pm clear`, cambio utente o nuova enrollment;
- package, versione, code, SHA-256, firma, permessi e `run-as` verificati;
- le due identita preesistenti sono `READY`, distinte e coerenti con il
  registry Raspberry;
- BlueZ 5.82, NTP, `cassav5bt.service` e `bluetooth.service` osservati attivi;
- monitor Raspberry avviato prima delle prove, senza fermare o riavviare i
  servizi;
- UPS mantenuto in sola discovery: il probe dati non e disponibile e nessun
  driver e stato inventato.

Esiti dei gate e delle prove non promuovibili:

- B0 su due Palmare: `SUPPLEMENTAL_FAIL`, gate formale invariato `PENDING`.
  Continuita, coesistenza Wi-Fi/BLE e foreground/background sono `PASS`; scan,
  advertising, GATT client/server e concorrenza scan-advertise non sono stati
  dimostrati;
- B1: rivalidazione read-only delle due identita `READY` completata;
- B2 diagnostico: il primo artefatto si e fermato al ciclo 1 con
  `STATUS_INVALID` ed e stato conservato immutabile. Le letture successive
  mostrano uno schema valido; il runner viene corretto per diagnosticare in
  modo redatto le letture transitorie prima di un eventuale retry con un nuovo
  nome di output;
- B3: non avviato, perche manca il tablet Postazione certificato;
- B4: state, chiave e coppie report/log private della sintesi storica `1/10`
  non sono disponibili ne localmente ne sul Raspberry. La sintesi pubblica
  non basta a riprendere il ledger: non e stato ricostruito, sovrascritto o
  incrementato;
- B5 e B6: non avviati.

### Baseline offline precedente

Preparazione offline implementata:

- matrice condivisa `configs/advanced-certification-targets.json` con package,
  versioni, code e SHA-256 Lab;
- B2, B3, B4 e monitor B5 consumano la matrice senza duplicare target;
- collector B5 schema v2 con `bootId` casuale nonzero, diverso dal precedente,
  condiviso tra runner e advertiser e mai incluso negli output redatti;
- migrazione automatica consentita soltanto a state legacy vuoti; state legacy
  con record vengono rifiutati;
- recovery post-commit, journal incompleto, tamper, inventario inatteso,
  finalizzazione `100/100`, file `0600` e divieto di overwrite coperti;
- preflight collector non mutante;
- monitor ADB continuo vincolato a seriale, package, versione, APK, Android
  user, UID, PID, reporter, sessione autenticata e ApplicationExitInfo;
- attestazione monitor redatta, senza seriale, account, PID, path o materiale
  di enrollment;
- supervisor B5 con ledger tentativi schema v1 separato dallo state collector,
  hash-chain, journal e recovery atomico;
- solo `DIRECT_CONTROL_ORCHESTRATION_TIMEOUT` con cleanup verificato e
  ritentabile; tre timeout consecutivi sospendono, un successo azzera il
  contatore e ogni altro errore invalida;
- ledger privato `0600` fail-closed su symlink, hardlink, clock regressivo,
  manomissione e overwrite;
- monitor Raspberry continuo per `cassav5bt.service`, `bluetooth.service`,
  boot ID, clock, `MainPID`, `NRestarts` e timestamp monotoni;
- attestazione Raspberry redatta e legata alla campagna, senza hostname, PID,
  path o identificatori;
- inventario unico read-only per ADB, Raspberry, BlueZ, NTP, UPS, servizi,
  registry, enrollment e permessi; l'UPS e solo discovery e non implica un
  driver prima dell'ispezione reale;
- verifica offline di matrice, Gradle, versioni, package, APK e parita dei
  sorgenti/test Bluetooth condivisi;
- autorizzazione B0-B4 vincolata alla campagna e precedente al primo slot;
- gate tecnico B5 vincolato allo state v2, al ledger, ai 100 report e alle
  attestazioni Android/Raspberry;
- esito tecnico limitato a `TECHNICAL_PASS/PENDING_REVIEW`: B5 resta
  `PENDING`;
- promotion gate separato, valido solo con sign-off successivo di un revisore
  distinto legato allo SHA-256 esatto dell'aggregato;
- manifest del pacchetto generato dalla allowlist reale e validato in entrambe
  le direzioni;
- evidenze storiche mancanti dichiarate esterne e non sintetizzabili;
- checklist, runbook e rollback preparati per la ripresa fisica;
- generatore ZIP sorgente riproducibile con output ricompilabili e materiale
  privato esclusi.

Terzo giro offline B5 implementato senza usare ADB, SSH, Bluetooth, UPS o
servizi reali:

- il gate tecnico usa un parser a schema esatto e fail-closed per impedire
  campi mancanti, aggiuntivi o incoerenti nell'aggregato;
- il gate produce un receipt tecnico privato che lega i byte dell'aggregato
  alla campagna, allo state collector, alla testa del ledger, alla
  autorizzazione B0-B4 e alle attestazioni Android/Raspberry;
- il promotion gate richiede quel receipt e blocca aggregati o evidenze
  sostituiti tra campagne, oltre a continuare a richiedere il sign-off
  indipendente;
- la finestra dei monitor e verificata sul primo e sull'ultimo tentativo del
  ledger, includendo timeout, retry e sospensioni, non soltanto le sessioni
  concluse con successo;
- il target Android accettato dal gate deve avere ruolo `handheld`;
- il monitor Android usa un numero di campioni corretto anche quando la durata
  non e divisibile per l'intervallo di polling e limita il campione finale
  alla deadline;
- i monitor Android e Raspberry pubblicano risultato privato e attestazione
  redatta come coppia recuperabile, con protezioni contro output parziali;
- un resume del supervisor dopo regressione del clock invalida la campagna e
  registra l'esito nel ledger.

B5 e B6 restano `PENDING`: questo incremento rinforza le prove e la
promozione, ma non aggiunge evidenze fisiche e non modifica il **49%**.

## Esito Simulazione Operativa 25+5 Del 2026-08-04

Il nuovo profilo applicativo usa un modello di arrivo aperto: 25 Palmare, 5
Postazioni, una azione ogni 3 secondi per device e comande con gap alternato
9/6 secondi. Lo smoke a quattro worker ha completato 1.200/1.200 azioni con
catalogo completo, media mobile 2.999,68 ms, media comande 7.600,55 ms,
realtime attivo e drain relazionale completo.

Esito `FAIL`: massimo 401 richieste in-flight, HTTP P95 134.555 ms e massimo
318.422 ms, una eccezione di invio comanda, 24/25 Palmare al target 16 e GUI
mobile in esaurimento risorse durante il refetch. Non avviare il full finche
non sono ridotti i refresh layout/ordini ridondanti e coalesciuti gli eventi
realtime. La simulazione non modifica i gate fisici ne il **49%**.

Build Lab certificate:

```text
Palmare Advanced 1.0.36 code 37
SHA-256 ccfd96034ad798649e95e41ac5404aab6be7f804bba095003be59bb6f4c95587

Postazione Advanced 2.0.22 code 24
SHA-256 60cee3c61f8aeb1a3c7fa2302f78202b59d58ba20f9b4504f52922b02402214f
```

Sequenza residua alla disponibilita del tablet e delle evidenze B4:

1. ripetere l'inventario unico read-only e mantenere UPS in sola discovery;
2. verificare senza mutazioni la Postazione certificata e installare la sua
   build Lab conservando dati ed enrollment;
3. completare B0-B3 con la coppia Palmare/Postazione; B4 riparte soltanto da
   uno state privato autentico e integro, mai dalla sola sintesi pubblica;
4. un solo pilot B5.7 diagnostico con state separato e non promuovibile;
5. nuova campagna ufficiale soltanto dopo PASS B0-B4: collector state,
   supervisor ledger e autorizzazione della stessa campagna;
6. baseline e monitor continui Android e Raspberry prima del primo tentativo,
   con target Android di ruolo `handheld` e copertura fino all'ultimo
   tentativo;
7. 100 record `COMMITTED` tramite supervisor; solo il timeout di
   orchestrazione con cleanup puo ritentare lo stesso slot;
8. finalizzazione e PASS naturale dei due monitor, quindi gate tecnico con
   manifest, state, ledger, autorizzazione e due attestazioni; archiviare il
   receipt tecnico privato emesso insieme all'aggregato;
9. review indipendente legata all'hash e promotion gate con il receipt della
   stessa campagna; senza receipt o sign-off B5 resta `PENDING`;
10. ripristino conservativo e health check senza riavviare il servizio;
11. B6 solo dopo la promozione formale di B5.

## Baseline Verifiche Offline Consolidate

```text
Suite Raspberry + TypeScript: 196/196 PASS
Contratti JSON:                 22/22 PASS
Shared:                        124/124 PASS
Scripts roadmap:      168 PASS, 2 SKIP, 0 failure
Test root:                       40/40 PASS
Advertiser Python:                7/7 PASS
Android Palmare:                197/197 PASS
Android Postazione:             190/190 PASS
Coerenza build Advanced:           9/9 PASS
Matrice + B3:                    32/32 PASS
B2 suite:                         34/34 PASS
B2 self-test:                   128/128 PASS
B0 capability runner:            21/21 PASS
Monitor Raspberry:              19/19 PASS
Collector B5:                    26/26 PASS
Governance B5:                    4/4 PASS
Gate tecnico B5:                33/33 PASS
Promotion gate B5:              12/12 PASS
Supervisor B5:                  18/18 PASS
Blocco mirato terzo giro:      103/103 PASS
Inventario read-only fixture:     5/5 PASS
Manifest bidirezionale:           4/4 PASS
Isolamento workspace:            13/13 PASS
Archivio sorgente:                 4/4 PASS
Simulazione operativa contratti:  22/22 PASS
```

Il validatore del pacchetto restituisce `ok=true`, zero file mancanti, zero
errori manifest e zero errori di isolamento. `roadmapPromotionAllowed=false`
e intenzionale: sei evidenze fisiche storiche assenti restano dichiarate
esterne e non sintetizzabili, mentre i nuovi gate fisici sono ancora
`PENDING`.

Questi conteggi includono il terzo giro offline e sono stati ottenuti senza
hardware. Non usare fixture o self-test come evidenza fisica.

Lo ZIP `V5BT-sorgenti-offline-20260803.zip` e il relativo checksum sono
superati e non devono essere distribuiti come stato corrente. La sostituzione
datata 20260804 deve essere generata dal root; nome definitivo e digest vanno
registrati soltanto dopo la generazione reale.

## Aggiornamento Operativo 25+5 Del 2026-08-04 11:00 CEST

Il micro-run sintetico successivo alla riconciliazione ordini mirata e alla
protezione delle risorse del simulatore e completamente verde. Nessun accesso
ADB, SSH, Bluetooth, UPS o periferica fisica e stato eseguito.

Evidenza autorevole:

```text
Run:                 v5bt_operations_25x5_micro_300_20260804110001
Palmare:             25
Postazioni:          5
Azioni:              300/300
Failure:             0
P95 azioni:          1.954 ms (limite 3.000 ms)
Massimo azioni:      4.582 ms (limite 30.000 ms)
P95 comande:         1.064 ms (limite 8.000 ms)
Gap mobile medio:    3.000 ms
Gap comande medio:   8.000 ms
Massimo in-flight:   17/60
Persistenza esatta:  25/25 Palmare, zero mancanti e zero duplicati
Drain relazionale:   PASS
Outbox non inviate:  0
Mirror pagamenti KO: 0
Errori GUI/5xx:      0
Runtime gate:        PASS
```

Report:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_micro_300_20260804110001/REPORT.md`.

Correzioni incluse nel risultato:

- la riconciliazione asincrona delle Postazioni persiste soltanto gli ordini
  effettivamente cambiati e il solo `lastWriteAt`, senza riscrivere l'intero
  dominio integrazione, audit o print spool;
- l'ACK notifiche idempotente ritenta esclusivamente gli errori MySQL
  transienti, con limite di tre tentativi;
- il coordinatore dei named lock distingue traffico foreground/background con
  fairness limitata e le relative metriche restano visibili nello snapshot;
- il simulatore riserva contemporaneamente `orderId` e `tableId`; la creazione
  comanda e le azioni Palmare/Postazione non possono acquisire lo stesso tavolo
  nello stesso intervallo e la reservation viene sempre rilasciata in
  `finally`;
- il workflow Postazione resta vincolato all'ordine effettivamente prenotato;
- il profilo lungo puo preparare le 651 fixture richieste riusando in modo
  seriale i 255 tavoli disponibili dopo l'esaurimento di ogni ciclo. Il riuso
  non e abilitato per i chiamanti che non lo richiedono esplicitamente.

Verifica successiva alle modifiche:

```text
Contratti simulazione operativa: 40/40 PASS
Riconciliazione, retry e workflow: 17/17 PASS
Sintassi runner/helper:            PASS
Preflight profilo lungo:           PASS
Profilo lungo dichiarato:          25 + 5, 6.000 azioni, 600 secondi
```

Un test runtime-metrics diretto resta sensibile alla macchina locale: si
attende la sorgente feature flag `env`, mentre trova l'override operativo
`systemd`. Gli altri 22 test dello stesso batch, inclusa la nuova metrica
named-lock, passano; non e una regressione del profilo 25+5.

Il prossimo gate sintetico e un nuovo smoke da 1.200 operazioni. Soltanto dopo
il suo PASS va avviato il profilo lungo da 6.000 operazioni. Queste prove non
promuovono alcun gate fisico e l'avanzamento ufficiale resta **49%**.

## Aggiornamento Batteria 120 Secondi Del 2026-08-04

Il traffico Android verso il server per lo stato batteria e ora limitato a un
invio ordinario ogni `120.000 ms` sia su Palmare Advanced sia su Postazione
Advanced. Il primo invio all'avvio resta immediato; Postazione mantiene inoltre
gli invii forzati necessari dopo una nuova configurazione server o un reale
cambio di identita del dispositivo. Gli aggiornamenti locali mostrati nella UI
restano immediati e non producono traffico di rete.

Postazione non effettua piu un POST per ogni broadcast Android
`ACTION_BATTERY_CHANGED`. Anche un tentativo di rete fallito viene conteggiato
nel throttling, evitando retry ravvicinati; un invio forzato non rinvia di altri
due minuti il successivo heartbeat periodico.

Verifica locale:

```text
Palmare Advanced:    197/197 test PASS, lintDebug PASS, assembleDebug PASS
Postazione Advanced: 194/194 test PASS, lintDebug PASS, assembleDebug PASS
Errori lint:         0
```

Gli APK prodotti sono esclusivamente build di sviluppo locali. Non sono stati
installati sui dispositivi, copiati tra gli artefatti certificati o usati per
modificare la matrice Lab: versioni e SHA-256 certificati restano invariati in
attesa della prossima build distribuita e della relativa ricertificazione.

## Aggiornamento Login Postazione A Due Fasi Del 2026-08-04

La Postazione non sceglie piu la postazione operativa dall'header. Il flusso
ora e sequenziale e vincolante:

1. `POST /api/auth/login` verifica username e PIN senza ricevere `station` o
   `stationName`;
2. il server restituisce esclusivamente le postazioni attive abilitate per
   l'utente in `availableWorkstations`;
3. il frontend conserva il token soltanto in memoria e mostra una seconda
   schermata con modale obbligatoria;
4. `POST /api/auth/workstation/select` convalida sessione, dispositivo,
   allowlist, configurazione e occupazione, poi associa la postazione alla
   sessione;
5. soltanto dopo la risposta positiva il frontend attiva sessione operativa,
   persistenza locale, heartbeat, sincronizzazioni, audio e notifiche native;
6. nell'header il nome postazione e una semplice etichetta. Il cambio richiede
   logout e un nuovo accesso.

Il pulsante `Cambia utente` nella seconda schermata chiude anche la sessione
server non ancora associata. Una allowlist esplicitamente vuota resta vuota e
non usa postazioni locali di fallback; gli utenti legacy privi del campo
`workstationIds` mantengono temporaneamente l'accesso alle postazioni attive
configurate. Prima del deploy operativo verificare quindi in `/impostazioni`
che ogni utente non legacy abbia almeno una postazione assegnata.

Il backend rifiuta anche il vecchio login diretto verso una postazione fuori
allowlist. L'heartbeat richiede una sessione gia associata, deve coincidere con
la postazione richiesta e rivalida l'autorizzazione utente. Una gara tra due
sessioni sulla stessa postazione produce una sola associazione valida.

File principali:

- `SORGENTE_SISTEMA/cassa-frontend/backend/auth/workstation-selection.js`
- `SORGENTE_SISTEMA/cassa-frontend/backend/auth/auth.handlers.js`
- `SORGENTE_SISTEMA/cassa-frontend/backend/routes/index.js`
- `SORGENTE_SISTEMA/cassa-frontend/backend/routes/route-handlers.js`
- `SORGENTE_SISTEMA/cassa-frontend/backend/server.js`
- `SORGENTE_SISTEMA/postazione/src/App.jsx`
- `SORGENTE_SISTEMA/postazione/src/workstationSelection.js`
- `APPLICATIVI/Postazione/web-frontend/src/App.jsx`
- `APPLICATIVI/Postazione/web-frontend/src/workstationSelection.js`

Verifica locale conclusa senza hardware:

```text
Backend login, selezione e sicurezza route: 27/27 PASS
Postazione servita:                      34/34 PASS
Postazione incorporata Android:          22/22 PASS
Contratti trasversali Postazione:        14/14 PASS
Build Vite delle due copie:              PASS
Playwright desktop/mobile:                2/2 PASS
Controllo sintassi backend:               PASS
```

La suite frontend aggregata dell'intero server resta a `78/86`: gli otto
contratti statici non verdi riguardano listino mobile, invio comanda mobile,
batteria mobile, dettaglio annullati, layout dettaglio e icone operative
Postazione. Non coinvolgono login, allowlist o selezione postazione e non sono
stati modificati in questo incremento.

Playwright ha verificato che la modale resti interamente nel viewport, non
copra l'HUD e non avvii API operative prima della selezione. E stato inoltre
corretto lo scroll interno lasciato dal focus del PIN sui viewport stretti.

## Deploy Login Postazione Del 2026-08-04

L'incremento e stato distribuito sul Raspberry operativo `192.168.1.79`.
`cassav5bt.service` e `bluetooth.service` risultavano attivi prima del deploy;
il preflight di database, SQLite, segreti e TLS e passato.

Il primo tentativo ha evidenziato che il `server.js` locale completo dipendeva
anche da un modulo backend piu recente non presente sul Raspberry. Il servizio
non ha superato l'health gate ed e stato ripristinato dal backup senza perdita
di dati. Il rollback ha riportato health MySQL positivo e servizio attivo.

Il secondo tentativo ha usato un overlay costruito sulla baseline remota e
limitato esclusivamente al login Postazione. Il risultato finale e:

```text
cassav5bt.service: active/running
NRestarts:          0
/api/health:        HTTP 200, MySQL OK
/postazione/:       HTTP 200, bundle index-D3-psHjs.js
route select:       presente, HTTP 401 senza sessione
bridge residui:     zero
```

Backup di rollback conservato sul Raspberry:

- `/home/admin/.v5bt-deploy-backups/20260804-144840-postazione-login-minimal`
- dist precedente in `SORGENTE_SISTEMA/postazione/dist.pre-20260804-144840`

Uno smoke live ha verificato login `200`, richiesta della seconda fase,
rifiuto `403 WORKSTATION_NOT_ALLOWED` per una postazione non assegnata e
logout `200`. La sessione di prova e stata chiusa.

Il database operativo contiene cinque utenti e, al momento del controllo,
tutti hanno `workstationIds: []`. Il comportamento fail-closed e quindi
corretto, ma nessun utente vedra postazioni selezionabili finche in
`/impostazioni` non verra assegnato almeno uno tra:

- `workstation_bar_principale`, nome operativo `BAR-1`;
- `workstation_cucina`, nome operativo `BAR-2`.

E stata inoltre compilata la Postazione Android con il nuovo frontend:

```text
Gradle testDebugUnitTest + lintDebug + assembleDebug: PASS
Package:      com.sentrapa.postazione.advanced
Versione:     2.0.22 code 24
Firma APK v2: valida
SHA-256:      b6925795cfa7d305aa4a03f2b15e86a2ba6c20b6244e4b1589e78936a5aab712
```

Artefatto:
`artifacts/Postazione-Advanced-v2.0.22-V5BT-Login-Postazione-20260804-debug.apk`.
Non e stato installato: i due device ADB disponibili sono entrambi Palmare
Advanced `SM-A165F`, non il tablet Postazione. Il deploy e la build non
promuovono gate fisici e l'avanzamento ufficiale resta **49%**.

## Accessi E Gate 25+5 Del 2026-08-04

Le informazioni precedenti sugli utenti senza Postazioni sono superate dallo
stato operativo registrato piu recente: i 5 utenti operativi risultano
abilitati alle tre funzioni `cassa`, `postazione` e `palmare` e alle Postazioni
BAR-1 e BAR-2. Nessun accesso hardware e stato eseguito in questo incremento.

Nel database locale di lavoro, 14/14 utenti hanno ora le tre funzioni e tutte
le sei Postazioni attive. Gli hash dei 14 record sono validi. Lo script
`scripts/enable-all-user-apps.mjs` esegue dry-run per default; con `--apply`
usa lock di riga, controllo hash ottimistico, transazione, rilettura canonica
MySQL e verifica post-commit. I backup privati non sovrascrivibili hanno
permessi `0600` in `.runtime/cassav5bt/user-access-backups`. Un secondo dry-run
ha confermato zero modifiche pendenti. Anche i 30 utenti sintetici del profilo
25+5 vengono creati con le tre funzioni e le cinque Postazioni di test.

Il micro
`v5bt_payment_admission_proxy_retry_metrics_micro300_20260804a` e `PASS`:
300/300 azioni, zero failure, picco in-flight 19, P95 azioni 2.555 ms, massimo
7.623 ms e P95 comande 1.905 ms. Persistenza 25/25 esatta, drain relazionale,
outbox, stampa, mirror pagamenti, GUI e cleanup sono verdi. Il report e stato
ridotto a 4.384.120 byte limitando a 600 i campioni di coda per processo senza
ridurre istogrammi o checkpoint.

Lo smoke successivo e stato arrestato volontariamente per pressione dell'host
dopo 1.011 azioni. Il checkpoint finale registra P95 azioni 6.051 ms, massimo
24.398 ms e P95 HTTP 1.991 ms. Non e stato creato un report promuovibile;
processi, porte e sessioni isolate sono stati ripuliti. La classificazione e
`ABORTED_HOST_PRESSURE`, non errore applicativo.

Il launcher ha ora un preflight Linux non mutante: micro richiede almeno 1 GiB
di `MemAvailable` e 512 MiB di `SwapFree`, smoke 3 GiB e 2 GiB, full 4 GiB e
3 GiB. Le esecuzioni reali sotto soglia vengono bloccate prima di build,
processi o dati. L'override esatto `LOADTEST_ALLOW_HOST_PRESSURE=1` e attestato
e non deve essere usato per qualificare la prova. Suite preflight e contratti:
56/56 PASS; contratti operativi: 47/47 PASS; test limite metriche: 5/5 PASS.

Le modifiche applicative comprendono inoltre prenotazione locale prioritaria
della payment lane prima del lock MySQL, retry proxy singolo e limitato ai GET
coalescibili interrotti prima degli header, e limite attestato dei campioni
runtime. Il prossimo smoke puo iniziare soltanto su un host che supera il
preflight; il full resta subordinato al PASS completo dello smoke. Le prove
sintetiche non cambiano la percentuale ufficiale, che resta **49%**.

## Confine Sessione Notifiche Backend Del 2026-08-05

E stata corretta la causa backend che poteva riproporre al login una comanda
pronta molto vecchia. Il pull verificava gia l'esistenza della sessione mobile,
ma considerava ancora eleggibili tutte le notifiche persistenti non confermate,
anche se create prima della sessione appena aperta.

Il server applica ora il cutoff autorevole
`notification.createdAt >= requesterSession.createdAt`. Il runtime SSE usa lo
stesso inizio sessione letto dal database: rifiuta con
`NOTIFICATION_SESSION_REVOKED` una riconnessione mobile con coppia utente/device
senza sessione, scarta replay e backlog anteriori e controlla anche il
`createdAt` della notifica incorporata in un handoff recente. La deduplica per
`eventId` impedisce che replay e flush pending consegnino due volte lo stesso
evento ed e limitata a 1024 ID per stream.

La risposta login espone inoltre il campo additivo `sessionStartedAt`, epoch ms
derivato da `session.createdAt` sul server. Il backend non accetta timestamp
client come autorita. Logout, evento creato durante il logout e nuovo login non
producono replay; una notifica creata nella nuova sessione resta invece valida.

Verifica locale mirata:

```text
Runtime SSE session cutoff/dedup:       5/5 PASS
Persistenza e priorita notifiche:      12/12 PASS
Stream notifiche e logout device:       4/4 PASS
Replay outbox tra logout/login:          1/1 PASS
Contratto epoch login:                  1/1 PASS
Routing mobile modificato:              1/1 PASS
Allarme assenza Postazioni:             1/1 PASS
Controllo sintassi file coinvolti:          PASS
```

L'inventario fisico read-only completato oggi e registrato come `COMPLETE` in
`ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/physical/v5bt-bench-inventory-redacted-20260805T032901Z.json`.
La controparte privata e in
`.runtime/cassav5bt/bench-inventory/v5bt-bench-inventory-private-20260805T032901Z.json`.
Questa evidenza e la correzione notifiche non promuovono da sole alcun gate
fisico; l'avanzamento ufficiale resta **49%**.

## Ricertificazione Sessione Notifiche Del 2026-08-05

Il target Palmare Lab corrente e ora `1.0.37` code `38`, package
`com.sentrapa.palmare.advanced`. L'artefatto e
`artifacts/Palmare-Advanced-v1.0.37-V5BT-B5.7-Lab-Notification-Session-20260805-debug.apk`
con SHA-256
`7e6f8adfca77ff8e7f3f461a0638bfc2224ee39bb57f6a1a27179fd969a75bd3`.

La ricertificazione offline chiude la suite Android `208/208`, lint con `0`
errori e `23` warning, frontend mobile canonico `29/29` e copia impacchettata
Android `29/29`. La build certifica il nuovo confine di sessione delle
notifiche lato client e il binding nativo della sessione, senza modificare API
business, server operativo o database.

Nessuna installazione o nuova cattura hardware e stata eseguita in questa
ricertificazione. Le evidenze fisiche precedenti restano storiche perche
acquisite con Palmare `1.0.36` code `37`; devono essere ripetute con `1.0.37`
prima di poter concorrere ai prerequisiti. B0-B5 restano `PENDING`, il pilot e
la campagna B5 non sono autorizzati e l'avanzamento ufficiale resta **49%**.

Il report corrente e
`ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/V5BT_PALMARE_NOTIFICATION_SESSION_RECERTIFICATION_20260805.md`.

## Regressione Fisica Logout Transport Del 2026-08-05

Il target Palmare Lab corrente e `Palmare Advanced 1.0.38` code `39`, package
`com.sentrapa.palmare.advanced`. L'artefatto
`artifacts/Palmare-Advanced-v1.0.38-V5BT-B5.7-Lab-Logout-Transport-20260805-debug.apk`
ha SHA-256
`c410cae24d5f6663edb9016346842721ea94b944640df49d79ce836a861d1323`;
la firma e rimasta invariata. La suite Android chiude `210/210` e lint chiude
con `0` errori e `23` warning.

Due Palmare sono stati aggiornati in-place senza perdere dati, identita o
enrollment. I nuovi login hanno restituito HTTP `200` con epoch ruotati; i
token precedenti e quelli revocati al logout hanno restituito HTTP `401`. Il
background autenticato non ha prodotto errori. Dopo il logout di entrambi i
Palmare le preferenze auth risultavano assenti, servizi e notifiche erano a
`0` e, per `135` secondi, poller, trasporto, batteria, audio, fatal e ANR sono
rimasti a `0` nel perimetro filtrato per package target e UID. Il rilancio e
rimasto sulla schermata login con gli stessi contatori a `0`.

Creazione e routing degli eventi non sono stati eseguiti e restano `NOT_RUN`.
Il verdetto e `PASS` soltanto per
`PHYSICAL_APPLICATION_REGRESSION / NON_GATE_EVIDENCE`: B0-B5 restano
`PENDING`, B6 resta chiusa e l'avanzamento ufficiale resta **49%**.

Report e companion pubblico redatto:
`ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/V5BT_PALMARE_NOTIFICATION_SESSION_PHYSICAL_REGRESSION_20260805.md`
e
`ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/reports/physical/v5bt-palmare-notification-session-physical-regression-redacted-20260805.json`.

## Giro Fisico B0/B2 Su Due Palmare Del 2026-08-05

Il giro corrente usa due Palmare Advanced `1.0.38` code `39`; il tablet
Postazione certificato non era disponibile. Le evidenze sono quindi
supplementari o diagnostiche e non promuovono gate formali.

B0 chiude `SUPPLEMENTAL_FAIL`. Scan e advertising sono `PASS` su entrambi i
Palmare, mentre GATT client e server sono `NOT_PROVEN` su entrambi.
Concorrenza scan/advertise, coesistenza Wi-Fi/BLE e foreground/background sono
`NOT_PROVEN` sul Palmare 1 e `PASS` sul Palmare 2. Tutti i controlli di
continuita Android sono `PASS`.

B2 ha completato `100/100` cicli con zero cicli falliti. Il p95 della presenza
anonima e `16.465` ms e il p95 dopo readiness di entrambi e `12.279` ms, contro
la soglia massima di `8.000` ms. L'evidenza resta `NON_GATE_EVIDENCE` e B2
resta `PENDING`.

L'attestazione Raspberry e `PASS` per `1.985.782` ms, `919` campioni e gap
massimo `6.140` ms. Continuita dei servizi, boot, clock, assenza restart e
copertura polling sono tutti `PASS`.

Il logout finale ha coperto `135` secondi nominali e finestre effettive di
`139` e `142` secondi. Poller, trasporto, batteria, audio, fatal, ANR, auth,
servizi, notifiche e waiter server sono tutti a `0`; la schermata login e
visibile su entrambi i Palmare.

Il report pubblico dedicato e
`reports/V5BT_B0_B2_TWO_HANDHELD_PHYSICAL_DIAGNOSTIC_20260805.md`. B0-B5
restano `PENDING`, B6 resta chiusa e l'avanzamento ufficiale resta **49%**.

Le future evidenze B2 sono ora schema 6 e incorporano un binding SHA-256
canonico alla matrice certificata. Le future attestazioni del monitor
Raspberry incorporano lo SHA-256 dell'intero journal privato finalizzato. I
file fisici gia raccolti non sono stati modificati. Prima di ripetere B0/B2
occorre correggere il contratto GATT Android, aggiungere un contatore
cumulativo di concorrenza scan/advertise e confrontare il rendezvous con un
pilot da 20 cicli e almeno 31 secondi di quiescenza tra i cicli.

Il consolidamento successivo chiude test root `49/49`, test roadmap
`172 PASS` con `2 SKIP` storici attesi, self-test B2 `133/133`,
contratti `22/22`, manifest bidirezionale e isolamento senza errori.

## Giro Fisico Cooldown Del 2026-08-05

Questa sezione e lo stato piu recente per la ripresa fisica. Le build correnti
sono Palmare Advanced `1.0.39` code `40`, SHA-256
`d0af2fd9341d5e50b49a4cd68fe4e2a0f70f6d28ef7c0acc1361191b5afffa65`,
e Postazione Advanced `2.0.23` code `25`, SHA-256
`3d55fa75e40e33134c8824b8c36a60d00622ea62528c67db3b74208fbcf868a5`.
Le suite Android chiudono `212/212` e `196/196`, con lint a zero errori. La
Postazione e stata soltanto compilata: il tablet certificato era assente.

Il consolidamento finale chiude test root `49/49`, roadmap Node `300 PASS` con
`2 SKIP` storici attesi, suite Raspberry `196/196`, self-test B2 `140/140` e
suite Android `212/212` e `196/196`.

Due Palmare sono stati aggiornati conservativamente. L'inventario successivo
conferma versione, hash, permessi, enrollment `READY`, binding registry e
servizi; resta incompleto soltanto per `UPS_DISCOVERY_UNAVAILABLE`.

B0 supplementare e stato acquisito per `120` secondi. Entrambi i Palmare
chiudono `6/7`: scan, advertising, GATT server open/close, concorrenza
scan/advertise, coesistenza Wi-Fi/BLE e foreground/background sono PASS. Il
GATT client e `NOT_PROVEN` senza la Postazione certificata. Ogni controllo di
continuita e PASS, senza crash o ANR. L'esito e
`SUPPLEMENTAL_FAIL / NON_GATE_EVIDENCE`; B0 resta `PENDING`.

Il pilot B2 cooldown chiude `20/20` con zero timeout ed errori radio. Tutte le
venti quiescenze monotone sono complete e durano almeno `31.000` ms. Il p95 e
`5.825` ms, il range `3.486..5.832` ms e il p95 dopo readiness `1.940` ms.
`pilotVerdict: PASS` non e promuovibile: B2 resta `PENDING` e richiede ancora
`100` cicli sulla coppia formale.

La continuita Raspberry e PASS su `758` campioni in `1.517.378` ms, gap
massimo `3.720` ms, con boot, clock e servizi stabili e zero restart. Dopo il
logout, una finestra di `135` secondi registra zero auth, servizi nativi
target, notifiche Advanced, tag rilevanti dei processi target, crash, ANR e
waiter server.

B4 non e stato modificato o ricostruito. B5 resta chiuso fino al PASS autentico
di B0-B4 e B6 resta chiuso fino alla promozione formale di B5. Il prossimo
passo e attendere il tablet Postazione certificato e procedere con inventario
read-only, B0 formale, B1, B2 formale da `100` cicli e B3 da `3.600` secondi.
Il report pubblico e
`reports/physical/V5BT_B0_B2_COOLDOWN_TWO_HANDHELD_PHYSICAL_20260805.md` nel
pacchetto roadmap. L'avanzamento ufficiale resta **49%**.

## Readiness Formale Offline B0-B3 Del 2026-08-05

E stato aggiunto `scripts/run-b0-android-formal-gate.mjs`, separato dal runner
supplementare. Richiede target espliciti, Palmare `SM-A165F`, Postazione
`SM-T503`, matrice corrente, sette capacita e continuita completa. Solo la
coppia interamente PASS puo produrre `FORMAL/PASS`; ogni altro esito resta
`NON_GATE_EVIDENCE/PENDING`.

Il B2 formale usa lo schema `7` e impone `100` quiescenze monotone da almeno
`31.000` ms, una prima di ogni ciclo. `--cycle-gap-ms` non e accettato in
modalita formale. Il pilot cooldown resta fisso a `20` cicli e non-gate. B3 e
allineato a Palmare `1.0.39` code `40` e Postazione `2.0.23` code `25`, con
confronto obbligatorio della firma installata prima dell'update.

Il tablet non e presente. Il vecchio B4 `1/10` resta storico non riprendibile;
non e stato ricostruito. La prossima raccolta B4 dovra iniziare in uno stato
privato nuovo `0/10`, dopo allineamento isolato del runtime Raspberry e con un
solo advertiser autenticato. Suite correnti: root `49/49`, roadmap
`315 PASS + 2 SKIP`, Raspberry `196/196`, B0 `51/51`, B2 `151/151`, B3
`41/41`, contratti `22/22`. Report:
`reports/V5BT_B0_B3_FORMAL_OFFLINE_READINESS_20260805.md`. Avanzamento
ufficiale: **49%**.

## Handoff B4 Matrix 3 Del 2026-08-05

La matrice certificata e schema `3` e include il pin SHA-256 del certificato
di firma per entrambi i ruoli. Il verifier reale usa `apksigner`, richiede un
solo certificato e confronta il pin; inventario e runner B0/B2 usano lo stesso
binding canonico.

Il nuovo collector B4 usa state privato schema `2` e rifiuta gli state legacy.
Lo state corrente e stato inizializzato ex novo a `0/10`, con matrice completa,
HMAC privata, file `0600` e directory `0700`. Due preflight sui Palmare hanno
restituito `ANDROID_EVIDENCE_STALE`; nessun record e stato scritto e lo state
e rimasto invariato. Non ricostruire o importare il vecchio `1/10`.

Lo staging Raspberry utilizzabile e la seconda release `matrix3-r2`, con
`168` file piu `SHA256SUMS`, manifest SHA-256
`9b1911ae938b637221361940e8d0ecba019bbdf1e4e0bac8b263c7957fc4c7b1` e
binding matrice
`45712f686dd521fc739929a985d7a56ccc44ef6264023db3014cf8dce2da66e7`.
La prima release e `SUPERSEDED`: non eseguirla e non aggiornarla. Nessuna
release e collegata a systemd o a processi attivi.

Ripresa consigliata: login su un solo Palmare, attesa del reporter fresco,
inventario e monitor read-only, B4.3 da almeno `90` secondi con unico
advertiser, cleanup e poi record dello slot `1/10`. Il secondo Palmare resta
disconnesso fino al proprio turno. B0-B3 formali attendono ancora il tablet
Postazione.

Suite correnti: root `52/52`, roadmap `320 PASS + 2 SKIP`, Raspberry
`196/196`, build reale `10/10`, collector B4 `27 PASS + 2 SKIP`. Report
pubblico:
`reports/V5BT_B4_MATRIX3_LEDGER_INITIALIZATION_20260805.md` nel pacchetto
roadmap.
Avanzamento ufficiale: **49%**.

## Handoff B4 Monitorato Del 2026-08-05

La catena offline B4 e ora chiusa end-to-end. Ogni slot richiede attestazioni
continue Android e Raspberry della stessa collection/capture e matrice. Il
Palmare e vincolato anche tramite commitment HMAC dell'hardware; il collector
rifiuta cambi dello state durante la raccolta e finalizza un manifest privato
schema `2`. Il gate Raspberry autorevole ripete parsing canonico, hash, binding,
copertura, target, permessi, symlink/hardlink e stabilita delle letture.

Il monitor Android `1.0.2` deriva i dati di collection esclusivamente dallo state,
mantiene package/ruolo fissi, accetta un campione reporter duplicato solo quando
sequence e timestamp restano accoppiati e freschi, azzera le chiavi e pubblica
l'attestazione atomicamente con rollback. Il monitor Raspberry lega runner e
release esatti e lo smoke SSH snapshot read-only e `PASS`.

Il primo slot fisico e stato registrato su Palmare Advanced `1.0.39` code `40`,
Android API `36`, modello `SM-A165F`. Il runner B4.3 ha chiuso `PASS` dopo `90`
secondi con `229` osservazioni accettate, zero rifiutate, zero errori e cleanup
completo. I tentativi respinti prima del record non contano nel ledger.

Continuita: monitor Android `PASS`, `120` secondi, `61` campioni e gap massimo
`2003` ms; monitor Raspberry `PASS`, `106063` ms, `22` campioni e gap massimo
`5004` ms. I servizi sorvegliati hanno zero restart e il cleanup e completo.
Il logout successivo ha riportato il Palmare alla schermata di accesso con
zero notifiche attive e zero servizi Bluetooth del package. Il monitor
canonico ha restituito `SESSION_LOGGED_OUT` e non ha pubblicato attestazioni.
Il banner `Configurazione aggiornata.` e pero rimasto visibile anche al login:
e una regressione UI ancora aperta. Non sostituire la build durante questa
raccolta B4, perche il ledger e vincolato alla matrice certificata corrente.

Suite correnti: root `87/87`, Android B4 `19/19`, Raspberry B4 `16/16`,
collector `37 PASS + 2 SKIP` storici, monitored-slot `14/14`, autorevole
`16/16`, catena B4 `67 PASS + 2 SKIP`, integrazione Android
`70 PASS + 2 SKIP`, Raspberry completa `198/198` e contratti `22/22`.

Lo state B4 corrente e `1/10`, `PENDING`, con `9` hardware distinti ancora da
acquisire una sola volta. B5 e B6 restano chiusi. Report pubblico:
`reports/V5BT_B4_MONITORED_PHYSICAL_SLOT_1_20260805.md` nel pacchetto roadmap.
Avanzamento ufficiale: **49%**.

## Handoff B4 Slot 2 Del 2026-08-05

Il secondo Palmare fisico distinto e stato acquisito nel ledger B4 corrente.
La cattura accettata usa la stessa build certificata e chiude il runner B4.3
`PASS` dopo `90` secondi con `270` osservazioni accettate, zero rifiutate,
zero errori e cleanup completo. Due tentativi precedenti con copertura monitor
incompleta sono rimasti separati e non sono stati registrati.

Attestazioni valide: Android `180` secondi, `91` campioni, gap massimo `2003`
ms; Raspberry `146657` ms, `30` campioni, gap massimo `5004` ms, zero restart
e cleanup completo. Il wrapper ha rivalidato binding, target, build, identita,
hash, copertura e unicita prima di scrivere lo slot. State e quattro evidenze
sono file regolari `0600`, link count 1.

Il logout finale e confermato da schermata di accesso, zero notifiche attive,
assenza dei servizi nativi target e risultato canonico `SESSION_LOGGED_OUT`.
I servizi Raspberry sono rimasti attivi e invariati; BlueZ ha chiuso senza
discovery o advertiser.

Lo state B4 corrente e `2/10`, `PENDING`, con `8` hardware distinti ancora da
acquisire. B5 e B6 restano chiusi. Report pubblico:
`reports/V5BT_B4_MONITORED_PHYSICAL_SLOT_2_20260805.md` nel pacchetto roadmap.
Avanzamento ufficiale: **49%**.

## Handoff Simulazione Ibrida B4 Del 2026-08-06

E disponibile il runner `run-b4-offline-hybrid-non-gate.mjs`. Accetta
esclusivamente uno state con due record fisici validi, li legge senza mutarli e
simula in RAM gli slot `3..10`. Il risultato corrente e `NON_GATE_PASS`; ordine,
unicita, hash-chain privata e redazione sono validi, con test `7/7 PASS`.

Il report privato e `0600`, no-overwrite e privo di identificatori, percorsi,
hash e timestamp fisici. Deve risiedere in una directory `0700` separata dallo
state e dal pacchetto; schema esatto, lock condiviso, `fsync` e rollback sono
fail-closed. Lo state e rimasto identico byte per byte. Non usare questo
risultato per finalizzare il collector o avviare il gate Raspberry: gli otto
sintetici contano `0`, il ledger resta `2/10`, B4 e B5 sono `PENDING`, B6 e
`BLOCKED` e il pilot B5.7 non e autorizzato.

Alla ripresa fisica, sostituire ogni slot simulato con una singola acquisizione
monitorata di un hardware Android distinto. Report pubblico:
`reports/V5BT_B4_TWO_PHYSICAL_EIGHT_SIMULATED_NON_GATE_20260806.md` nel
pacchetto roadmap. Avanzamento ufficiale: **49%**.

## Handoff Corrente Carico Applicativo Del 2026-08-06

Il flusso realtime richiede ora autenticazione canonica per SSE e Postazione.
Il browser rimane attivo fino alla conclusione del drain relazionale, evitando
residui outbox nel cleanup. Lo scheduler mantiene la cadenza contrattuale anche
nel profilo micro; la payment lane valuta la liveness nell'intervallo reale da
`enqueue` ad `admission`. Le verifiche mirate chiudono `37/37 PASS` e la suite
integrata chiude `86/86 PASS`.

Il micro autorevole
`v5bt_operations_25x5_micro_300_20260806044848_77e6735309` e `PASS`:

```text
Azioni:                 300/300
P95 azioni:             2794 ms
P95 comande:            2000 ms
Gap medio comande:      7027,62 ms
SSE connesse:           25/25
Failure:                0
Residui outbox:         0
Errori GUI:             0
```

Report valido:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_micro_300_20260806044848_77e6735309/report.json`.
Un run intermedio e stato invalidato e non deve essere contato, citato come
PASS o usato per readiness.

Il prossimo gate applicativo e un nuovo smoke da 1.200 operazioni. Il full da
6.000 operazioni resta subordinato al PASS completo dello smoke. Il risultato
micro non modifica i gate fisici: B4 resta `2/10` fisici, con otto simulati che
contano `0`; B5 resta `PENDING`, non autorizzato e a `0/100`; B6 resta
`PENDING` con avvio `BLOCKED`. Nessun gate B e stato promosso.

La chiusura offline complessiva conta `568 PASS`, `2 SKIP` intenzionali per
evidenze storiche esterne non ricostruibili e `0 FAIL` nel pacchetto roadmap;
la suite radice chiude `87/87 PASS`. Il fixture CLI del monitor Android B4 usa
ora direttamente il runtime Node della workspace e non dipende dal `PATH` del
sistema. Manifest bidirezionale, contratti e validatore del pacchetto sono
`PASS`; la readiness applicativa resta correttamente `NOT_READY` finche smoke
e full non producono nuove evidenze valide.

Avanzamento roadmap complessiva: **49%**

## Handoff Banco B4 Web Grafico Del 2026-08-10

E disponibile un banco persistente con otto Palmare Advanced web in otto
finestre Chrome grafiche, contesti, account, storage e sessioni distinti per
gli slot logici `3..10`. Il launcher e
`SORGENTE_SISTEMA/cassa-frontend/scripts/run-v5bt-b4-web-gui-lab.mjs` e offre
`--start`, `--status`, `--stop` e `--dry-run`.

Il run corrente ha raggiunto `ACTIVE`: `8/8` finestre, pagine e sessioni;
copertura `SIMULATED_10_OF_10`, rete soltanto loopback, zero accessi hardware,
otto screenshot privati `0600` e test contrattuali `10/10 PASS`. Il supervisore
controlla ogni cinque secondi che il ledger fisico resti identico e invalida il
banco in caso di chiusura browser/pagina o variazione dello state.

La copertura GUI simulata puo essere considerata chiusa, ma non e una
promozione del gate. Il ledger autorevole resta `2/10`, i web contano `0`, B4 e
B5 restano `PENDING`, B6 resta `BLOCKED`. Non eseguire B5 sulla base di questo
report. Runbook e rapporto redatto sono nella roadmap, rispettivamente
`testing/B4_EIGHT_CHROME_GUI_NON_GATE.md` e
`reports/V5BT_B4_EIGHT_CHROME_GUI_NON_GATE_20260810.md`.

Avanzamento roadmap complessiva: **49%**

## Handoff Canary Marker Station-State Del 2026-08-06

Il writer MySQL split dispone ora di un canary fail-safe per le sole scritture
parziali di `integration.stationStates`. Il flag backend
`BACKEND_STATION_STATE_MARKER_LOCK_SKIP` e disattivato per default e nel
deploy systemd ufficiale. Quando e attivo, il marker viene escluso sia dal
lock sia dall'upsert soltanto se e canonico; assenza, kind, JSON, posizione o
hash non validi mantengono il percorso canonico autoriparante nella stessa
transazione.

Il nuovo audit schema `1` richiede probe realmente osservati, contabilita
`probe = applied + fallback`, almeno un'applicazione, marker integro e zero
errori o rollback. La suite integrata chiude `318/318 PASS`; due test MySQL
reali dimostrano che ID differenti procedono senza il marker condiviso, lo
stesso ID resta serializzato e il bootstrap concorrente conserva entrambe le
entry con un solo marker.

Il canary ON completa `300/300` azioni con zero errori business e audit
`81/81/0`, ma fallisce il P95 azioni: `3183` ms su limite `3000` ms. Il
riferimento OFF immediatamente successivo completa `300/300` con tutti i gate
PASS: P95 azioni `1793` ms e comande `1535` ms. Entrambi hanno attribution
`COMPLETE`, drain e cleanup puliti.

Decisione: respingere l'ON e mantenere l'OFF ufficiale. Nessuno smoke e stato
avviato. Report e hash sono registrati in
`DOCUMENTAZIONE/V5BT_STATION_STATE_MARKER_CANARY_20260806.md`. Nessun hardware
fisico usato; B4 resta `2/10`, B5 `PENDING`, B6 `BLOCKED`.

Avanzamento roadmap complessiva: **49%**

## Handoff Attribuzione Owner E Canary Batching Del 2026-08-06

Il passo offline ha eliminato la cardinalita dinamica delle metriche di stampa:
la label operativa privata conserva il batch ID, mentre la label esportata e
costante. Owner auto-print, spool e station-state espongono ora timer di fase
stabili e contatori heartbeat. Il workflow owner e stato estratto nel modulo
dedicato per mantenere `server.js` entro il budget architetturale, con `706`
righe di margine residue.

Il nuovo `latencyAttribution` schema `1` e bloccante nei report V5BT. Verifica
raccolta completa dei worker, istogrammi, contatori, parita cardinali e assenza
di label dinamiche per `proxyOwner`, `appStateMysql`, `printSpool` e
`stationState`. Le label inattese non vengono esportate. La suite integrata
chiude `241/241 PASS`.

Il profilo qualificabile resta fissato a
`PRINT_SPOOL_AUTO_PRINT_REMOTE_OWNER_INTERVAL_MS=25`. L'unico override
diagnostico ammesso e `100` ms; qualsiasi altro valore viene rifiutato e il
canary e sempre `NON_GATE/NON_PROMOTABLE`.

Il canary a `100` ms ha completato `300/300` azioni con zero errori business,
cadenze valide, P95 comande `3771` ms, drain e cleanup completi. Tutte le
famiglie di attribution e la raccolta `6/6` worker sono `COMPLETE`, ma il P95
azioni e `4166` ms contro il limite di `3000` ms. Il candidato e quindi
respinto e non viene promosso.

La ripetizione contemporanea a `25` ms ha anch'essa attribution `COMPLETE`, ma
ha subito una contesa station-state sopraggiunta durante la prova: MySQL
station-state massimo `12747` ms, P95 azioni `13684` ms e P95 comande `10309`
ms. Il run e `FAIL` e non viene usato come confronto prestazionale del
batching. Non e stato autorizzato alcuno smoke da `1200` operazioni.

Report e SHA-256:

```text
logs/loadtest-v5bt_operations_25x5_micro_300_owner_batch100_202608061447/report.json
0d97470e467c7b64e4094dd56b4b339f9101ca8b4255f8efc9e8a0bb5601fefb

logs/loadtest-v5bt_operations_25x5_micro_300_owner_batch25_202608061450/report.json
a5d112eecb4a8ffef00b32e7fe1701fb44dede7f34ccb0f303732571a051a028
```

Nessun hardware, ADB, SSH, Bluetooth o UPS e stato usato. Lo swap temporaneo
da `8 GiB` e stato rimosso dopo le prove; `/swap.img` e rimasto invariato. Il
prossimo candidato offline deve agire sulla contesa MySQL station-state e sul
marker condiviso, dietro flag disattivato per default e con fallback canonico.
B4 resta `2/10`, B5 `PENDING` e B6 `BLOCKED`.

Avanzamento roadmap complessiva: **49%**

## Handoff Smoke 25+5 E Diagnostica Payment Del 2026-08-06

Dopo il micro precedente sono state chiuse due fonti di lavoro MySQL evitabile.
I worker API tentano ora l'inoltro del flush asincrono ordini all'owner prima
di leggere l'app-state e acquisire il lock globale; l'owner o il fallback
locale eseguono invece il percorso protetto. Inoltre `integration.lastWriteAt`
entra nella stessa transazione bulk degli ordini e non apre una seconda
transazione dopo il bulk.

Il launcher usa il preflight host schema v2: oltre a `MemAvailable` e
`SwapFree` legge il load average a un minuto e lo divide per le CPU logiche,
con massimo `0,75`. Il report qualificabile deve attestare stato `PASS`,
enforcement attivo e nessun override. Il profilo canonico mantiene le quattro
esclusioni incrociate disattivate, payment concurrency `2`, print concurrency
`1` e flush asincrono ordini ogni `500` ms. L'ipotesi print concurrency `2` e
stata respinta dal contratto come variante non promuovibile e non e entrata
nelle catture autorevoli.

Il nuovo micro
`v5bt_operations_25x5_micro_300_20260806062339_76859e7a94` e `PASS`:

```text
Azioni:                 300/300, tutte riuscite
P95 / max azioni:       2572 / 5231,17 ms
P95 comande:            1792 ms
Cadenza mobile:         3012,58 ms
Cadenza comande:        7029,77 ms
Picco in-flight:        24/60
SSE:                    25/25
Burst / errori GUI:     0 / 0
Drain / cleanup:        PASS / PASS
```

Report:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_micro_300_20260806062339_76859e7a94/report.json`.

Lo smoke immediatamente successivo
`v5bt_operations_25x5_smoke_1200_20260806062803_b089bfb08e` completa tutte le
quote ma e `FAIL`:

```text
Azioni:                 1200/1200
Successi / failure:     1199 / 1 TABLE_LOCKED
P95 / max azioni:       19559 / 39122,53 ms
P95 comande:            4748 ms, PASS
Cadenza mobile:         3632,89 ms, FAIL
Cadenza comande:        8963,27 ms, FAIL
Picco in-flight:        53/60
Burst anticipati:       0
Drain / cleanup:        PASS / PASS
```

La singola failure e una `order.price_override` respinta per contesa tavolo.
Il problema dominante e pero il backlog pagamenti: su 89 operazioni
`laneWait.completed` misura media `14.219,90` ms e massimo `31.088` ms;
`payment.free_split` raggiunge P95 `30.550` ms e massimo `34.563` ms. A fine
run outbox eventi, stampa, fiscale e payment mirror sono tutti drenati a zero,
quindi non si tratta di cleanup incompleto ma di capacita sostenuta insufficiente
durante la finestra operativa.

Report:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_smoke_1200_20260806062803_b089bfb08e/report.json`.

La classificazione applicativa corrente e micro `PASS`, smoke `FAIL`, full
`NOT_RUN`. Non avviare il full finche un nuovo smoke non rispetta zero failure,
cadenze, P95 e massimo assoluto. Le prove sono locali, non promuovono B4-B6 e
non modificano l'avanzamento ufficiale.

Avanzamento roadmap complessiva: **49%**

## Handoff Diagnostico Payment Concurrency 3 Del 2026-08-06

Il run
`v5bt_operations_25x5_smoke_1200_diag_payment3_20260806064515` usa payment
concurrency `3` ed e rigorosamente `NON_GATE/NON_PROMOTABLE`. Ha completato
`1.200/1.200` azioni con zero failure o eccezioni, esattamente 16 comande per
ognuno dei 25 Palmari e drain e cleanup puliti:

```text
P95 / max azioni:       14060 / 43709,53 ms, FAIL
P95 comande:            5432 ms, PASS
Cadenza mobile:         3530,34 ms, FAIL
Cadenza comande:        8746,91 ms, FAIL
Picco in-flight:        55/60
Payment lane:           107 operazioni
Attesa payment media:   circa 10236 ms
Attesa payment massima: 33384 ms
```

La concorrenza `3` riduce l'attesa payment media rispetto al run canonico a
`2`, ma aumenta contesa e coda estrema e resta molto oltre le soglie delle
azioni. La variante e quindi respinta come impostazione qualificabile e non
sostituisce lo smoke autorevole. Report:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_smoke_1200_diag_payment3_20260806064515/report.json`.

Il nuovo retry business di `order.price_override` e ammesso soltanto per HTTP
`409` con codice esatto `TABLE_LOCKED`, fino a due tentativi totali. Entrambi
i tentativi condividono lo stesso `logicalActionId`, la stessa
`idempotencyKey` e lo stesso payload congelato; ogni altro errore termina
subito e un secondo conflitto rimane failure. Test dedicati e di contratto
coprono classificazione stretta, tetto dei tentativi e identita invariata.

La classificazione autorevole resta micro `PASS`, smoke `FAIL`, full
`NOT_RUN`; il full non e autorizzato e i gate B4-B6 non cambiano.

Avanzamento roadmap complessiva: **49%**

## Handoff Canary Contesa Ordini Del 2026-08-06

Il passo offline successivo ha aggiunto tre canary diagnostici, tutti
feature-flagged e disattivati per default: lock MySQL `NOWAIT`, separazione di
`integration.lastWriteAt` dal bulk ordini e separazione di `sequence` quando
il batch non contiene notifiche. L'atomicita `notification + sequence` resta
sempre invariata. Le metriche e il report attestano esplicitamente i flag e
il numero di scritture separate; runner ufficiale e configurazione systemd
richiedono invece tutti e tre i flag a `false`/`0`.

I quattro micro confrontabili hanno completato `300/300` azioni senza errori
business, duplicati o code residue. Drain, cleanup e auto-print owner sono
sempre `PASS`, ma nessun nuovo candidato ha superato il gate P95 azioni:

```text
NOWAIT:                       azioni P95 5626 ms, comande P95 2796 ms
Ripetizione stabile OFF:      azioni P95 3422 ms, comande P95 2522 ms
lastWriteAt separato:         azioni P95 3149 ms, comande P95 2260 ms
lastWriteAt + sequence safe:  azioni P95 6716 ms, comande P95 2163 ms
Limiti:                       azioni P95 3000 ms, comande P95 8000 ms
```

Report e SHA-256:

```text
logs/loadtest-v5bt_operations_25x5_micro_300_nowait_202608061347/report.json
529ed9b0723fb71c8d8fbe35a4bafdda0b497b0f1ab62a0666dfc93ab3402da8

logs/loadtest-v5bt_operations_25x5_micro_300_stable_202608061354/report.json
c57e06688d9055234852423d9b9cffd5c11184c65fc8914580fe39a1e44ba134

logs/loadtest-v5bt_operations_25x5_micro_300_detached_lastwrite_202608061405/report.json
ff15c14c2019ae11c64b22e8e3605c7fbfbbadc4e897e2e4bc217777db4c5649

logs/loadtest-v5bt_operations_25x5_micro_300_detached_metadata_202608061411/report.json
324de0bca25187055ed53ebd409bf531ac22790bc702f37236353b65f151506d
```

Le varianti sono state respinte e non sono entrate nella configurazione
ufficiale. Non e stato avviato uno smoke da `1200`, perche nessun nuovo micro
lo autorizzava. La suite allargata mirata chiude `231/231 PASS`; i controlli
coprono repository MySQL, flush asincrono, auto-print owner, metriche runtime,
architettura e contratti del load test.

Il prossimo passo offline deve profilare il lavoro serializzato dall'owner e
la contesa tra spool di stampa e stato postazione. I lock tavolo non risultano
il collo di bottiglia dominante di questi run; non riproporre retry radio o
separazione metadata senza una nuova ipotesi misurabile. Nessun hardware e
stato utilizzato, B4 resta `2/10`, B5 resta `PENDING` e B6 resta `BLOCKED`.

Avanzamento roadmap complessiva: **49%**

## Stato Corrente Finale Del 2026-08-06

Lo stato piu recente sostituisce il "prossimo passo" del paragrafo precedente:
il canary fail-safe del marker MySQL station-state e completo, la suite
integrata chiude `318/318 PASS` e i test InnoDB reali confermano isolamento per
ID e bootstrap concorrente. L'ON diagnostico e respinto per P95 azioni `3183`
ms; l'OFF ufficiale passa con P95 azioni `1793` ms e comande `1535` ms.

I profili ufficiali restano marker station-state OFF e owner auto-print a `25`
ms. Il prossimo passo offline e un nuovo smoke qualificabile da `1200`
operazioni sul profilo completamente OFF; il full resta vietato fino al PASS
dello smoke. Dettagli, report e hash sono in
`DOCUMENTAZIONE/V5BT_STATION_STATE_MARKER_CANARY_20260806.md`.

Nessun hardware usato; B4 `2/10`, B5 `PENDING`, B6 `BLOCKED`.

Avanzamento roadmap complessiva: **49%**

## Handoff Smoke 1200 Isolato Del 2026-08-06

Il nuovo smoke qualificabile
`v5bt_operations_25x5_smoke_1200_off_isolated_202608061541` e stato eseguito
con profilo ufficiale, marker station-state OFF, owner auto-print `25 ms` e
zero override. Prima del run sono stati aggiunti spool stampa per-run con
cleanup bloccante e binding di tutti i backend a `127.0.0.1`. Contratti V5BT
`86/86 PASS`, gate architetturale backend `143/143 PASS`; preflight host
enforced e controllo live delle porte `PASS`.

Il run completa `1200/1200` azioni ma e `FAIL`: 6 azioni fallite, P95 azioni
`17358 ms`, massimo `54134,22 ms`, P95 comande `8167 ms`, cadenza mobile
`3862,75 ms` e cadenza comande `9606,89 ms`. Mancano 4 comande persistite, con
zero duplicati. Drain, owner audit, marker audit, attribution, GUI e cleanup
sono tutti `PASS`.

La causa misurata e la contesa MySQL: `450` row-lock wait per `697149 ms`;
station-state e proxy owner raggiungono P95 `10000 ms`, il dispatch P95
`5793 ms` e il backpressure tocca `60/60`. Sono comparsi quattro fallimenti
ordine correlati al backlog, una indisponibilita del contatore e un deadlock
sullo spostamento sala. Il marker diagnostico resta respinto e OFF.

L'evidenza e sigillata `0400/0500`; SHA-256 del manifest:
`b614357ca690dde05dc27ddafb2d4122460d7d1764655c3e3c4f71e323adaf93`.
Zero porte/processi/Redis residui, spool storico identico e rimosse soltanto
le sei tabelle MySQL del run. Dettagli in
`DOCUMENTAZIONE/V5BT_SMOKE_1200_ISOLATED_20260806.md`.

Classificazione: micro `PASS`, smoke `FAIL`, full `NOT_RUN`. Prossimo passo:
canary fail-safe sulla riga condivisa `integration.lastWriteAt` e sul lock
ordering, poi micro ufficiale; non ripetere lo smoke prima del PASS micro.
B4 `2/10`, B5 `PENDING`, B6 `BLOCKED`.

Avanzamento roadmap complessiva: **49%**

## Handoff Canary LastWrite Coalesce Del 2026-08-07

E stato implementato un canary fail-safe per coalescere il marker
`integration.lastWriteAt` degli heartbeat station-state. La coda conserva il
`MAX` anche fuori ordine o durante un flush, reinserisce il massimo dopo un
errore, esegue recovery monotono all'avvio, rifiuta timestamp invalidi o
futuri ed e drenata su `SIGINT` e `SIGTERM`. La guardia limita il percorso al
writer station-state: presenza, login/logout e notifiche restano nel commit
canonico. Contatori e gauge coprono enqueue, coalescing, batch, flush, retry,
errori, recovery, profondita, running e anzianita del pendente.

Il confronto micro chiude entrambe le quote a `300/300`. OFF misura P95
azioni `5853` ms, P95 comande `3652` ms, `135` lock wait e `74012` ms di
tempo lock. ON misura P95 azioni `9323` ms, P95 comande `8448` ms, `124` lock
wait e `120055` ms di tempo lock; la coda chiude `91/91`, con `71` enqueue
coalescati in `20` batch e zero residui.

La variante ON e respinta per prestazioni e il flag resta OFF. Nessuno smoke
da `1200` e autorizzato. Il prossimo canary deve usare `NOWAIT` fail-fast con
reschedule esplicito e confronto A/B/A. Evidenze sigillate: manifest OFF
`9a79262eec9bbeaa947ee067552cfa620768495c4d2480bf63f0cf1bbe68fedb` e
manifest ON
`b3faeae2868dabf08bedc0a31dcc0d918d4f3e718b5b293504affae349140c57`.

Verifica: focused `172/172 PASS`, contratti `100/100 PASS`, gate `7/7 PASS`;
full suite backend, rerun isolato: `1906/1906 PASS`. La prima esecuzione
aveva chiuso `1905/1906` con un solo errore non riprodotto. Dettagli in
`DOCUMENTAZIONE/V5BT_LASTWRITE_COALESCE_CANARY_20260807.md`.

Nessun hardware usato. B4 `2/10`, B5 `PENDING`, B6 `BLOCKED`.

Avanzamento roadmap complessiva: **49%**

## Handoff LastWrite NOWAIT A/B/A Del 2026-08-07

E stato implementato il flush ordinario `integration.lastWriteAt` con lock
`NOWAIT`, mantenendo bloccante la recovery di avvio. Le collisioni MySQL
`3572/ER_LOCK_NOWAIT` e MariaDB `1205/ER_LOCK_WAIT_TIMEOUT` diventano
contention deferral con retry e backoff; il reinserimento conserva sempre il
`MAX`. Il gate lastWrite schema `2` attesta modalita lock, contabilita dei
deferral e assenza di residui. L'attestazione con MySQL reale copre sia
fallimento rapido e rollback sia recovery bloccante.

Durante i test e stato scoperto e corretto un difetto del confronto monotono:
un JSON scalare gia decodificato dal driver MySQL poteva essere considerato
non valido e consentire la regressione di `lastWriteAt`. Il confronto ora
normalizza sia il valore analizzato sia quello scalare grezzo. Verifica:
focused `248/248 PASS`, contratti `103/103 PASS`, stress combinato per `10`
giri `50/50 PASS`, blocco ambiente `23/23 PASS` e full suite finale
`1918/1918 PASS`.

Il deadlock di bootstrap e stato riprodotto anche nel test combinato. Il trace
InnoDB lo ha ricondotto al marker, tra chiave `PRIMARY` e gap degli indici. Il
fix separa l'upsert del marker e usa il mutex marker soltanto per le entry
nuove, lasciando paralleli gli heartbeat su entry esistenti. I test MySQL
reali coprono marker preesistente con `16` coppie, `25` ID nuovi e stesso ID
con conservazione del `MAX`; `INVOCATION_ID` e `JOURNAL_STREAM` sono isolati
nei test.

Il confronto A/B/A chiude A1 `300/300`, P95 azioni/comande `3212/2247` ms,
`115` lock wait e `30233` ms di tempo lock: `FAIL` per P95 azioni, con anche
un `GUI_UNEXPECTED_5XX`. B chiude `300/300`, P95 `3490/2165` ms, `104` wait
e `15738` ms: gate lastWrite `PASS` con `86` enqueue, `60` coalescenze, `24`
batch, `6/6` deferral e zero errori, ma esito `FAIL` sul P95 azioni. A2 chiude
`300/300`, P95 `2831/2521` ms, `112` wait e `27851` ms: `PASS`.

Contro il punto medio A1/A2, B peggiora il P95 azioni di `468,5 ms`
(`+15,51%`), migliora il P95 comande di `219 ms` (`-9,19%`) e riduce il tempo
lock del `45,81%`. Verdetto `REJECTED_ACTION_P95`: flag operativo OFF e
nessuno smoke da `1200`.

Manifest A1
`7684907648ca561099d4ab96bda8724658a97e747e4d461ecf046f7f1e85e526`, B
`148d3c3d33d39117f2517df780d0c7968159661bea217f961a00297242df915d`, A2
`dc69dd51149db7b4fac9d0bc376ec6ed38ec80032c97bcb95bba20aaa3948b58`;
manifest aggregato
`ed0fe6f771ad4250d6514deb9ccf6a7db385a4ff462de63020bba1b92f579742`.
Bundle: `SORGENTE_SISTEMA/logs/v5bt-lastwrite-nowait-aba-20260807`. Dettagli
in `DOCUMENTAZIONE/V5BT_LASTWRITE_NOWAIT_ABA_20260807.md`.

Nessun hardware usato. B4 `2/10`, B5 `PENDING`, B6 `BLOCKED`.

Avanzamento roadmap complessiva: **49%**

## Preflight Fisico Complessivo Del 2026-08-10

L'inventario unico read-only ha rilevato due Palmare certificati collegati:
package, versione `1.0.39` code `40`, APK, firma, permessi ed enrollment
`READY` coincidono con la matrice. Entrambi risultano fuori sessione e i
reporter non hanno copertura corrente; non sono stati eseguiti reinstall,
login automatici, nuova enrollment o modifiche ai dati applicativi.

La Postazione certificata e il Raspberry non erano disponibili. Il riepilogo
redatto termina quindi `INCOMPLETE` e non autorizza B0 formale, B2, B3, pilot
B5.7 o campagna B5. Il ledger B4 resta integro a `2/10`: i due Palmare sono
gia conteggiati e non possono creare un nuovo slot.

Il runner ora richiede sempre copertura dei ruoli `handheld` e `station` per
emettere `COMPLETE`. Il rerun redatto corrente vede entrambi i Palmare ma
segnala esplicitamente ruolo Postazione e Raspberry mancanti. Un tentativo
precedente senza ADB nel `PATH` resta conservato come fallito.

I file storici privati della raccolta B4 sono stati normalizzati a `0600`;
le directory sono `0700` e non sono presenti symlink. Al ritorno dell'hardware
occorre ripetere prima l'inventario, avviare i monitor, effettuare login
controllato e verificare reporter freschi. La sequenza ufficiale resta B0-B3
con Palmare/Postazione, poi altri otto hardware fisici distinti per B4.

Verifica offline: stato `10/10`, inventario `16/16`, manifest `7/7`, consistenza
build `11/11` e runner B0 `12/12`; validatore pacchetto e dry-run B0 sono
`PASS`, con cattura fisica correttamente ancora `PENDING`.

Dettagli:
`DOCUMENTAZIONE/V5BT_ROADMAP_PHYSICAL_PREFLIGHT_20260810.md`.

Avanzamento roadmap complessiva: **49%**

## Handoff Rehearsal Web B5.7 Del 2026-08-10

Il launcher del banco grafico dispone ora di `--pilot`, oltre a `--start`,
`--status`, `--stop` e `--dry-run`. Il comando usa il Palmare Chrome dello
slot logico `3` e una macchina a stati HTTP solo loopback. Il run valido ha
chiuso `NON_GATE_PASS`: `ACTIVE`, `4/4` PING/PONG, un `CLOSE_ACK`, zero
errori, cleanup `0/0` e sessione autenticata preservata.

Il primo tentativo WebSocket e `NON_GATE_FAIL` per timeout ed e conservato
privatamente; il successivo PASS HTTP e un run distinto e non lo sovrascrive.
Richiesta e risultato del run sono privati `0600`, atomici e non
sovrascrivibili. Il supervisor usa `umask 0077`; lo status pubblico riporta
solo integrita del ledger ed esito redatto.

Verifica: launcher e pilot `19/19 PASS`. Sono inoltre PASS, su dati sintetici,
i self-test direct-control smoke, collector cento sessioni, supervisor cento
commit e gate tecnico cento sessioni. GUI e pipeline sintetica restano prove
separate e non correlate.

Nessun hardware e stato usato. Il ledger B4 resta byte-identico a `2/10`; B4
e B5 restano `PENDING`, B5 resta `0/100` ufficiali e B6 resta `BLOCKED`. Il
pilot fisico non e autorizzato da questo rehearsal.

Documenti:
`testing/B5_WEB_GUI_LOOPBACK_DIAGNOSTIC.md` e
`reports/V5BT_B5_WEB_GUI_LOOPBACK_DIAGNOSTIC_20260810.md` nel pacchetto
roadmap.

Avanzamento roadmap complessiva: **49%**

## Handoff Workload DOM B4 Del 2026-08-10

Il banco persistente da otto Palmare Chrome dispone anche del comando
`--workload`. Va eseguito soltanto dopo `--start` e un `--status` che confermi
`ACTIVE`, heartbeat fresco, `8/8` finestre, pagine e sessioni e ledger integro.
Il pilot B5.7 e il workload sono mutuamente esclusivi.

Profilo esatto: emulazione mobile/touch, `20` azioni DOM seriali per Palmare,
`160` azioni complessive, `8` comande per Palmare e `64` complessive. Ogni
sessione ammette una sola azione in-flight; cadenza azioni `3000 ms`, media
invio comande fra `7000` e `8000 ms`, batteria a `120000 ms`. Il driver deve
interagire col DOM reale e non iniettare chiamate business dirette.

Il monitor del launcher resta attivo durante il run. Richiesta e risultato
privati sono `0600`, vincolati da commitment e non sovrascrivibili; il report
pubblico non espone account, token, PID, percorsi, URL, hash privati o
identificatori. Sessione persa, errore DOM/HTTP, conteggio o cadenza fuori
contratto, concorrenza maggiore di uno o variazione del ledger chiudono
fail-closed.

I primi due run live sono terminali e immutabili: il primo ha chiuso
`NON_GATE_FAIL` con `26/160` azioni e `10/64` comande; il secondo con `83/160`
azioni, `33/64` comande e `513` risposte HTTP inattese. Entrambi hanno lasciato
il ledger fisico invariato a `2/10`.

Le diagnostiche hanno portato a correggere `lineId` canonici, correlazione
delle mutazioni, recovery overlay, drain in-flight e heartbeat fail-closed
della Postazione isolata. Le suite mirate correnti sono `54/54 PASS`; manca
ancora un nuovo workload live completo dopo tali correzioni. Non riportare
`NON_GATE_PASS` finche un run distinto non dimostra `160/160`, `64/64`,
cadenze conformi, otto sessioni preservate, zero errori e ledger byte-identico.
Chrome conteggiati `0`, B4 e B5 `PENDING`, B5 `0/100`, B6 `BLOCKED`.

Documenti:
`testing/B4_EIGHT_CHROME_GUI_NON_GATE.md` e
`reports/V5BT_B4_EIGHT_CHROME_DOM_WORKLOAD_NON_GATE_20260810.md` nel pacchetto
roadmap.

Avanzamento roadmap complessiva: **49%**

## Roadmap Rimanente E Snapshot Del 2026-08-17

La lista operativa B0-B11, i blocker correnti e l'ordine di ripresa sono in
`DOCUMENTAZIONE/ROADMAP_RIMANENTE_V5BT_20260817.md`. Il documento distingue i
risultati software/non-gate dai gate fisici e mantiene l'avanzamento ufficiale
al 49%.

## Handoff Postazione API 31 Compat Del 2026-08-17

Il package affiancato `com.sentrapa.postazione.advanced.partial` e ora sulla
variante `2.0.23-api31compat`, code `25`, SHA-256
`c117dad07b1bbff88315770fccc4eba6d13d70ddb200300b901693e1ea636575`.
L'installazione `adb install -r` ha preservato preferenze e identita; lo
stato enrollment finale e `READY`.

Il confronto fisico ha isolato il filtro ServiceData Samsung API 31: la build
con filtro controller vedeva zero risultati, mentre il fallback unfiltered
non-gate finale ha prodotto `2.471` callback, `9` UUID V5BT e `9` payload
validi. Sono state osservate `36` finestre scan-advertise concorrenti, p95
`5.735 ms` e zero errori. Wi-Fi HTTPS `5/5`; background stabile per
`31,253 s` (`durationMs=31253`), `7` campioni e gap massimo `5,228 s`
(`maxGapMs=5228`).

Una cattura sulla build immediatamente precedente, con sorgenti Bluetooth
identici, ha completato connessione, profilo e MTU `1/1/1`, fermandosi su
`HELLO_WRITE_FAILED` contro lo stimulus profile-only. Il retest sull'APK finale
ha registrato `9` tentativi, `6` connessioni e `9` errori senza sessione
stabile: non dichiarare sessione, mutual auth o direct control PASS. Lo smoke
GATT Raspberry e il cleanup sono `PASS`. Il monitor Raspberry
retry 5 e `PASS` con `227` campioni in `464,501 s` (`durationMs=464501`) e gap
massimo `5,992 s` (`maxGapMs=5992`); lo staging retry 4 copre `20` campioni in
`33,660 s` (`durationMs=33660`), gap `3,019 s` (`maxGapMs=3019`), senza
restart, health o hash fault. Servizi operativi, PID e restart count sono
rimasti invariati.

Il report finale classifica `gattClientRuntime FAIL` e
`gattServerRuntime NOT_RUN`; gli altri `14` controlli sono `PASS`. Il verdetto
aggregato resta quindi `NON_GATE_FAIL`.

Per chiudere il prossimo diagnostico serve uno stimulus GATT completo che
supporti HELLO, autenticazione reciproca, session key, PING/PONG e CLOSE_ACK.
Fino ad allora il verdetto aggregato resta `NON_GATE_FAIL`.

Il fix batteria ancora la pianificazione al completamento della notifica
precedente. La misura finale copre `3` notifiche in `270090 ms`, con intervalli
`120074 ms` e `121517 ms`: `batteryCadence PASS`. La variante `partial`
generica mantiene cleartext OFF; soltanto `api31Compat` consente HTTP locale
derivato dal portale HTTPS verso il servizio batteria `8865`. Nessun fallback
HTTP e ammesso per frontend, API business o radio.

Report pubblici redatti:
`reports/physical/V5BT_API31_COMPAT_PHYSICAL_NON_GATE_20260817.md` nel pacchetto
roadmap e
`reports/physical/v5bt-api31-compat-physical-non-gate-20260817.json`. Suite
completa `485/485 PASS`, runner report `17/17 PASS`. Stati ufficiali e
avanzamento restano invariati.

Avanzamento roadmap complessiva: **49%**

## Handoff Chiusura Software Bluetooth B6-B11 Del 2026-08-18

La baseline da conservare ha verdetto `SOFTWARE PASS OFFLINE / NON-GATE` e
nessun blocker residuo nel core transport/software coperto; non chiude
l'intera roadmap. Include A2 Android-Android senza downgrade
A1, reliable DATA/ACK, store peer-bound schema `3`, route sequence persistente
e bus diagnostico shadow. Il router deve continuare a rifiutare frame
business: `businessMessagesForwarded=0`,
`businessTransport=LAN_HTTP_SSE`.

Sul Raspberry il provider B9 e dinamico e fail-closed: health loopback
alimenta il solo bit `serverReachable` nel ServiceData BlueZ v1; route
`LAN/NONE`, RTT e queue depth restano in `RouteAdvertisementV1`. Health stale
o regressivo forza `serverReachable=false`; il budget
operativo e `<=4750 ms`. Batteria e UPS Raspberry restano `UNKNOWN`, i flag
sono OFF per default e non esiste ancora una prova fisica dell'advertiser.

Prima di modificare o attivare il tratto Bluetooth:

1. usare Node 24 e rieseguire la suite Raspberry completa;
2. eseguire Gradle serialmente su Palmare e Postazione;
3. confermare golden B6 e matrice `DATA_RX/DATA_TX/ACK_TX`;
4. rieseguire lo schema 2 come regressione software, quindi B11 massimo schema
   3 con 2 Palmari fisici + 8 virtuali, 1 Postazione fisica + 2 virtuali, 1
   Raspberry fisico, cassa automatica e RT virtuali;
5. aggiornare i conteggi nei due documenti di chiusura se la suite cambia;
6. lasciare tutti i flag OFF fuori dalle build Lab esplicitamente configurate.

Lo storico B11 schema 1 resta `NON_GATE_PASS 4500/4500`, con digest
`2527641f52ad15459ede6debe628c9dd392b53e774ca39179c59dc95b3adb3a1`.
La baseline schema 2 chiude `9100/9100` su 91 link, `2600/2600` azioni, 800
comande e `100/100` transazioni su cassa automatica e RT virtuali. Tutti i 16
attori sono virtuali, il business BT e zero e il digest e
`6b527f1003329004628dc79abad1db2d2ca607a68551f7030e699abda7ef8f37`.
Palmare debug e Postazione debug chiudono entrambi 59 classi e `340/340 PASS`,
zero failure, errori o skip. Il watchdog advertiser Postazione `api31Compat`
chiude `7/7 PASS` come test mirato, non come suite full della variante. Sono
risultati software non-gate, non evidenze radio.

Il nuovo massimo schema 3 e `MAXIMUM_MIXED_PHYSICAL_VIRTUAL_SYSTEM_NON_GATE`.
Il risultato corrente e `MIXED_NON_GATE_INCOMPLETE`: `2/4` attori fisici
osservati, cioe i due Palmari; Postazione e Raspberry risultano `0/1`;
radio, business fisico, monitor e soak sono `NOT_RUN`. Il contratto eseguibile
schema 3 e `MIXED_NON_GATE_INCOMPLETE`-only e non puo emettere un PASS.

I target 4/4, `600/600` cicli sui sei link real-real con HELLO/auth/data
bidirezionale/cleanup, `600/600` azioni incluse 160 comande, monitor 4/4 e
soak wall-clock >= `7200000 ms` restano criteri per una futura versione del
contratto/harness. Non abilitarla senza manifest e receipt fisici byte-bound,
record verificabili per ciascun link e attore, timestamp e provenance live. I
`4000` cicli cross-domain e `4500` virtual-only restano attribuiti solo al
modello software; nessun target fisico puo essere sostituito.

Nel v3 corrente `WAIVED_NON_GATE` e soltanto metadato per una policy futura e
non soddisfa readiness. L'inventario certifica l'APK con SHA-256 byte-esatto e
deriva la copertura signer dallo stesso binding: ignorare il signer lascia
l'APK non certificato e il risultato `INCOMPLETE`. Non aggiungere una probe
signer separata in questa versione.

Il prossimo lavoro fisico resta separato: completare B4 `10/10`, B5 `100/100`
con sign-off, quindi B6 e B11 reali. Attualmente B4 e `2/10`, B5 `0/100`, B6
`PENDING/BLOCKED`. Non ricostruire evidenze mancanti e non usare i simulatori
per promuovere i gate.

Documenti:
`DOCUMENTAZIONE/V5BT_CHIUSURA_SOFTWARE_BLUETOOTH_20260818.md` e
`reports/V5BT_B6_B11_SOFTWARE_CLOSURE_NON_GATE_20260818.md` nel pacchetto
roadmap. Per il massimo:
`reports/V5BT_B11_MAXIMUM_MIXED_PHYSICAL_VIRTUAL_NON_GATE_20260818.md`.
La baseline schema 2 resta in
`reports/V5BT_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818.md`.

Avanzamento roadmap complessiva: **49%**

## Handoff Consolidato Del 2026-08-18

Questo aggiornamento prevale sui conteggi software precedenti, senza
sovrascrivere le evidenze storiche. Il core transport/software B7-B11 e
`NON_GATE_PASS`; i corrispondenti gate fisici restano `PENDING`. Il commitment
B5 e implementato, ma non sostituisce evidenze o promozione.

Verifiche correnti:

- Raspberry/Node 24 `318/318 PASS`; `303/303` resta lo snapshot del
  consolidamento precedente e `292/292` quello della telemetria periodica;
- B11 runner+helper `17/17 PASS`, report schema 2 rigorosamente NON-GATE;
- Postazione `api31Compat` full offline `374/374 PASS`, lint e assemble
  `PASS`; configurazione `NON_INSTALLATA` e fix API 24 incluso;
- Palmare A2 `18/18 PASS`;
- badge diagnostico Bluetooth frontend completato su Palmare e Postazione,
  nascosto senza flag o contratto nativo, bounded fail-closed, con cleanup e
  senza identificatori o claim business; Palmare `6/6`, Postazione `39/39`,
  typecheck/build e quattro viewport positivi;
- P-010 avanzato per tranche: storage diretto eliminato nel perimetro e
  analytics decomposto in tipi, normalizzatori e builder puri, preservando
  export, HTTP e payload fiscali; funzionali `465/465` e `469/469`, build
  positivi;
- commitment account/device B5 con digest canonico domain-separated redatto
  nello state schema `3`, nei `100` record, nell'attestazione Android `1.1`,
  nell'aggregate `1.5` e nel receipt `1.1`. La promotion `1.3` ricalcola dal
  ledger e dai byte esatti delle due attestazioni i tre digest sorgente;
  legacy read-only `PENDING`.

I passi successivi P-010 estraggono `reservations.ts` in
`reservationModel.ts`, la policy prodotto del composer e il modello puro del
dialogo di recovery; i mirati chiudono rispettivamente `21/21`, `6/6` e
`11/11 PASS` per tree. Sono state inoltre rimosse `38` priorita CSS ridondanti
con equivalenza di stile e pixel verificata: `!important` scende da `305` al
budget `267`. Architecture chiude `11/12 PASS` per tree e resta bloccata solo
dal gate LOC sui quattro monoliti TSX `TablePaymentWizard`, `TablesWorkspace`,
`PaymentSettlementSection` e `AnalyticsWorkspace`.

Il commitment B5 chiude mirati `83/83 PASS` e Raspberry `303/303 PASS`;
nessun hardware e stato usato e nessun gate promosso.

Conservare senza sovrascrivere i tre workload DOM del 18 agosto:

- run 1: `160/160`, `114` successi, `46` failure, conteggio HTTP `565`;
- run 2: abort a `87/160`;
- run 3: `130/160`, `113` successi, `17` failure, zero HTTP failure e
  `stopReason=PAGE_CLOSED`.

Il verdetto e `NON_GATE_FAIL`; non eseguire altri retry. Le correzioni chiudono
`75/75 PASS` e la suite aggiuntiva `55/55 PASS`, ma il residuo sotto carico
resta aperto. Non usare questi PASS per promuovere B4-B11.

Avanzamento roadmap complessiva: **49%**
