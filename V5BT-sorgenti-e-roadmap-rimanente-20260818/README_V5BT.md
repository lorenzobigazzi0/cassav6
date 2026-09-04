# Cassa V5BT

Aggiornamento test fisici del 2026-08-17:
`DOCUMENTAZIONE/V5BT_TEST_FISICI_20260817.md`. Il diagnostico ravvicinato sui
due Palmare ha chiuso `61/100`, mentre il pilot con cooldown ha chiuso
`20/20 PASS` con p95 `6.737 ms`; sono entrambi non-gate. I gate formali restano
in attesa di una Postazione API 33 o successiva. La nuova variante Postazione
API 31 compat ha ripristinato discovery e coesistenza fisica, ma resta
`NON_GATE_FAIL` perche lo smoke profile-only non completa la sessione GATT.

Questa directory e la workspace autorevole V5BT. Contiene server, database,
frontend, wrapper Android, strumenti di deploy e roadmap Bluetooth. Le
baseline sono di sola consultazione; le modifiche applicative si eseguono in
`SORGENTE_SISTEMA` e negli alberi canonici sotto `APPLICATIVI`.

## Stato Operativo

Alla data del 5 agosto 2026 il Raspberry e due telefoni Android sono di nuovo
raggiungibili. Entrambi i telefoni restano Palmare Advanced; il tablet
Postazione certificato non e collegato. E stato acquisito un inventario
read-only, sono stati salvati privatamente gli APK e i dati necessari al
rollback e le due app sono state aggiornate alla build Lab certificata con
`adb install -r -g`, senza uninstall, `pm clear`, nuova enrollment o cambio
utente Android.

Il 17 agosto e stato inoltre provato il tablet API 31 tramite un package
affiancato non-gate. L'aggiornamento conservativo ha preservato dati e identita;
discovery, coesistenza Wi-Fi/BLE, background e il tratto iniziale GATT sono
documentati nel report dedicato. Questa prova non rende il tablet una
Postazione certificata.

Le due identita preesistenti risultano `READY`, distinte e coerenti con il
registry Raspberry. BlueZ, NTP e i servizi osservati risultano disponibili;
la lettura dati UPS resta `INCOMPLETE` perche sul target non e presente uno
strumento interrogabile. Non e stato inventato alcun driver. Il servizio
principale V5BT e `bluetooth.service` non devono essere fermati, riavviati o
ricaricati durante i gate Bluetooth. Il monitor fisico del giro precedente si
e concluso `PASS`
dopo 11.091.818 ms e 5.541 campioni, con gap massimo 3.490 ms e senza reboot o
restart dei servizi.

L'avanzamento ufficiale della roadmap resta **49%** finche nuove evidenze
fisiche di gate valide non vengono raccolte e revisionate.

La ripresa fisica non ha modificato API business, server operativo o database.
La correzione URL Palmare e stata applicata sia alla build Lab installata sia
all'APK normale ricompilato; gli altri comportamenti applicativi restano
invariati.

La ricertificazione Palmare del 4 agosto corregge il server predefinito a
`https://192.168.1.79:5380/mobile/`, conserva lo stesso URL quando e gia
configurato e migra soltanto i precedenti default `192.168.0.67` e
`192.168.1.182`. La build usata per le catture radio del 4 agosto era Palmare
`1.0.36` code `37` e Postazione `2.0.22` code `24`, con firma APK v2 valida.
Introduce una
isteresi di advertising di 8 secondi dopo la prima osservazione valida. La
suite Android chiude `197/197` sul Palmare e `190/190` sulla Postazione.
L'inventario read-only successivo e valido per Android, Raspberry, BlueZ, NTP,
servizi, registry ed enrollment; resta `INCOMPLETE` esclusivamente il probe
dati UPS non disponibile.

Dal 5 agosto i target Lab correnti sono Palmare `1.0.39` code `40` e
Postazione `2.0.23` code `25`. Le suite Android chiudono rispettivamente
`212/212` e `196/196`, con lint a zero errori. Il Palmare e stato installato
in-place su due telefoni preservando dati, identita, enrollment e firma; la
Postazione e stata compilata, ma il tablet certificato resta assente. Le prove
su due Palmare sono diagnostiche e non promuovono B0-B5.

## App Android

| App | Package | Versione | Code |
| --- | --- | --- | ---: |
| Palmare Advanced | `com.sentrapa.palmare.advanced` | `1.0.39` | 40 |
| Postazione Advanced | `com.sentrapa.postazione.advanced` | `2.0.23` | 25 |

Build normali da ripristinare dopo le prove Lab:

| App | Artefatto | SHA-256 |
| --- | --- | --- |
| Palmare | `artifacts/Palmare-Advanced-v1.0.36-V5BT-No-HTTP-Fallback-debug.apk` | `a1f10e89f0d91be57fe240b9f6295f7c28895448bda14952fd5bc0e5630d5b30` |
| Postazione | `artifacts/Postazione-Advanced-v2.0.22-V5BT-No-Web-Bridges-debug.apk` | `be297b3223fcbff45ff68245ab049a8c37fc83943376dd4a610d8cd82cc18769` |

Build Lab certificate correnti dalla matrice condivisa:

| App | Artefatto | SHA-256 |
| --- | --- | --- |
| Palmare | `artifacts/Palmare-Advanced-v1.0.39-V5BT-B0-B2-Cooldown-Lab-20260805-debug.apk` | `d0af2fd9341d5e50b49a4cd68fe4e2a0f70f6d28ef7c0acc1361191b5afffa65` |
| Postazione | `artifacts/Postazione-Advanced-v2.0.23-V5BT-B0-B2-Cooldown-Lab-20260805-debug.apk` | `3d55fa75e40e33134c8824b8c36a60d00622ea62528c67db3b74208fbcf868a5` |

I package sono distinti e gli aggiornamenti fisici devono usare
`adb install -r -g`: mai disinstallare, usare `pm clear` o cancellare
enrollment e dati.
I flag Bluetooth delle build normali restano disattivati.

## Server E Database

| Componente | Valore V5BT |
| --- | --- |
| Frontend HTTPS | `5380` |
| Backend locale | `5381` |
| Realtime riservato | `5382` |
| API worker riservato | `5383` |
| Batteria | `8865` |
| Schema MySQL | `cassa_v5bt` |
| Utente MySQL | `cassa_v5bt_app@127.0.0.1` |
| Runtime privato | `.runtime/cassav5bt` |
| Namespace Redis/MQTT | `cassav5bt` |

Il profilo `real` abilita stampa TCP, fiscale e cassa automatica reali. Gli
endpoint e le credenziali sono letti esclusivamente da
`.runtime/cassav5bt/hardware.env`, di proprieta dell'utente corrente e con
permessi `0600`. Il file non entra negli archivi.

Per una verifica locale priva di I/O hardware:

```bash
CASSAV5BT_HARDWARE_MODE=simulated ./start-v5bt.sh
```

Provisioning e preflight:

```bash
./database/provision-cassa-v5bt.sh
CASSAV5BT_PREFLIGHT_ONLY=1 ./start-v5bt.sh
```

Avvio e arresto ordinari:

```bash
./start-v5bt.sh
./stop-v5bt.sh
```

## Simulazione Operativa 25+5

Il profilo locale `v5bt-operations-30` simula il carico massimo di 25 Palmare
Advanced e 5 Postazioni Advanced senza usare hardware. Ogni device avvia una
azione ogni 3 secondi misurati sul dispatch reale; un ritardo sposta il turno
successivo senza recuperi a raffica. Ogni Palmare crea comande con gap alternato
di 9 e 6 secondi, media target 7,5 secondi e gate fra 7 e 8 secondi.

Il giro full esegue 200 azioni per device, 6.000 totali e 2.000 comande; lo
smoke usa 40 azioni per device, 1.200 totali e 400 comande. Il nuovo micro usa
10 azioni per device, 300 totali e 100 comande. Il catalogo copre storno,
correzione, annullo, spostamenti tavolo e sala, pagamenti, stampa, notifiche,
trasferimenti e il passaggio Tavoli/Banco tramite UI Playwright.

Palmare e Postazione dispongono ora di coordinatori anti-tempesta: un solo
refresh/sync attivo, al massimo un trailing per raffica, deduplica degli eventi
realtime sul Palmare, layout single-flight sulla Postazione e cancellazione al
logout o all'unmount. Il contratto scheduler v2 rende bloccanti le partenze
reali anticipate e conserva il piano soltanto come diagnostica. I gate
richiedono zero burst anticipati, massimo 2
in-flight per device e 60 globali, P95 azioni entro 3 secondi, P95 comande entro
8 secondi e nessuna azione oltre 30 secondi. Ogni GUI puo effettuare, per
ciascuna route calda layout/ordini, al massimo `10 + 2 * azioniPerDevice`
letture; request failure, HTTP 5xx ed errori console devono essere zero.

La persistenza deve coincidere esattamente con la quota per Palmare, senza
perdite o duplicati, e ogni retry della stessa comanda deve riusare la chiave
idempotente stabile. La suite contratti della simulazione e **59/59 PASS**.

Stampanti, fiscale, cassa automatica e batteria usano soltanto mock loopback;
la notifica batteria e fissata a un aggiornamento ogni 120 secondi.
BLE e hardware non sono emulati; le azioni fiscali distruttive restano fuori
dal carico ordinario. Comandi, gate e criteri di accettazione sono in
`SORGENTE_SISTEMA/cassa-frontend/V5BT_OPERATIONS_30_LOADTEST.md`. Queste prove
non promuovono i gate fisici e non modificano il 49% ufficiale.

### Stato Corrente Del 2026-08-06

I worker API inoltrano ora il flush asincrono ordini all'owner prima della
lettura dell'app-state e del lock MySQL globale; il fallback locale conserva
il lock. `integration.lastWriteAt` viene scritto insieme agli ordini nella
stessa operazione bulk. Il preflight host schema v2 verifica inoltre memoria,
swap e load average a un minuto per CPU, con limite `0,75`; un override resta
diagnostico e non promuovibile. La print lane canonica resta a concorrenza
`1`: la variante `2` e rifiutata come non promuovibile.

Il micro autorevole
`v5bt_operations_25x5_micro_300_20260806062339_76859e7a94` e `PASS` con
`300/300` azioni riuscite, P95 azioni `2.572` ms, massimo `5.231,17` ms, P95
comande `1.792` ms, cadenza mobile `3.012,58` ms e comande `7.029,77` ms.
Registra `25/25` SSE, picco globale `24/60`, zero burst, errori GUI o residui
nel drain. Report:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_micro_300_20260806062339_76859e7a94/report.json`.

Lo smoke
`v5bt_operations_25x5_smoke_1200_20260806062803_b089bfb08e` completa
`1.200/1.200` azioni ma e `FAIL`: `1.199` successi, una risposta
`TABLE_LOCKED`, P95 azioni `19.559` ms, massimo `39.122,53` ms, cadenza mobile
`3.632,89` ms e comande `8.963,27` ms. Il P95 comande e conforme a `4.748` ms,
ma la payment lane accumula attesa: media `14.219,90` ms e massimo `31.088` ms
su `laneWait.completed`; `payment.free_split` raggiunge P95 `30.550` ms. Il
drain e il cleanup finali sono comunque completi e senza residui. Report:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_smoke_1200_20260806062803_b089bfb08e/report.json`.

Il run
`v5bt_operations_25x5_smoke_1200_diag_payment3_20260806064515` prova payment
concurrency `3` ed e `NON_GATE/NON_PROMOTABLE`. Chiude `1.200/1.200` successi,
zero failure o eccezioni, 16 comande esatte per ciascuno dei 25 Palmari e
drain e cleanup puliti, ma fallisce cadenza mobile (`3.530,34` ms), cadenza
comande (`8.746,91` ms), P95 azioni (`14.060` ms) e massimo (`43.709,53` ms).
Il P95 comande passa a `5.432` ms e il picco resta `55/60`. L'attesa payment
media aggregata scende a circa `10.236` ms su 107 operazioni, mentre il massimo
sale a `33.384` ms: la minore attesa media non compensa contesa e coda estrema,
percio la concorrenza `3` e respinta. Report:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_smoke_1200_diag_payment3_20260806064515/report.json`.

Il retry di `order.price_override` ammette solo HTTP `409/TABLE_LOCKED`, per
due tentativi totali al massimo e con `logicalActionId` e `idempotencyKey`
invariati. Ogni altro errore termina subito e un conflitto persistente resta
failure; test dedicati e di contratto proteggono questi vincoli.

Il full resta `NOT_RUN` e non e autorizzato finche un nuovo smoke non chiude
tutti i gate. Queste prove non promuovono i gate fisici: l'avanzamento
ufficiale resta `49%` e gli stati B rimangono invariati.

## Roadmap Bluetooth

Lo stato pubblico autorevole e `configs/current-roadmap-status.json`: progresso
ufficiale `49%`; B4 `2/10` fisici con otto simulati che contano `0`; B5
`PENDING`, pilot e campagna non autorizzati, `0/100` sessioni; B6 `PENDING` con
avvio `BLOCKED`. Il carico applicativo corrente e micro `PASS`, smoke `FAIL` e
full `NOT_RUN`.

La preparazione offline corrente comprende:

- matrice unica di package, versioni, codici e SHA-256;
- gate B2 e B3 vincolati alle build certificate;
- collector B5 con `bootId` casuale privato, stato v2, recovery atomico,
  preflight non mutante e finalizzazione esatta `100/100`;
- monitor ADB continuo vincolato a target, utente, processo, reporter e
  sessione autenticata; il target accettato dal gate deve avere ruolo
  `handheld` e la finestra copre tutti i tentativi, compresi timeout e retry;
- supervisor B5 con ledger tentativi schema v1, hash-chain, recovery atomico e
  policy automatica timeout/sospensione/invalidazione; un resume dopo una
  regressione del clock invalida la campagna;
- monitor Raspberry continuo per `cassav5bt.service`, `bluetooth.service`,
  boot ID, clock, PID, restart e timestamp monotoni;
- scheduling del monitor Android corretto per durate non divisibili per il
  polling, con campione finale limitato alla deadline;
- pubblicazione accoppiata e recuperabile di risultato privato e attestazione
  redatta per entrambi i monitor, senza lasciare una coppia apparentemente
  completa dopo un'interruzione;
- inventario unico read-only per ADB, Raspberry, BlueZ, NTP, UPS, servizi,
  registry, enrollment e permessi;
- verifica offline di matrice, Gradle, package, versioni, APK e parita dei
  sorgenti Bluetooth condivisi;
- autorizzazione B0-B4 legata alla campagna e sign-off indipendente legato
  allo SHA-256 esatto dell'aggregato tecnico;
- gate tecnico B5 con parsing a schema esatto e fail-closed, vincolato a
  manifest, state, ledger e due attestazioni redatte;
- receipt tecnico privato che lega aggregato, campagna, stato collector,
  ledger dei tentativi, autorizzazione e attestazioni; il promotion gate lo
  richiede e rifiuta assenze, mismatch o sostituzioni tra campagne;
- checklist e runbook per pilot diagnostico, campagna, stop e rollback;
- manifest del pacchetto verificato in entrambe le direzioni.

Solo `DIRECT_CONTROL_ORCHESTRATION_TIMEOUT` con cleanup verificato puo
ritentare lo stesso slot. Tre timeout consecutivi sospendono la campagna, un
successo azzera il contatore e ogni altro errore la invalida.

Il risultato tecnico positivo e `TECHNICAL_PASS`, ma lascia B5
`PENDING_REVIEW` e B6 `PENDING`. Solo una review successiva di un soggetto
distinto, vincolata all'hash dell'aggregato, puo produrre il PASS formale B5.
L'UPS resta in modalita discovery: nessun driver viene assunto prima di vedere
l'hardware reale.

Ultima evidenza fisica disponibile, ora storica:

- B0: evidenza supplementare su due Palmare acquisita; continuita,
  coesistenza Wi-Fi/BLE, foreground/background e attivita reale di scan e
  advertising sono `PASS` su entrambi. Client e server GATT sono
  `FAIL/NOT_PROVEN`: non risultano attivita client ne un owner server runtime
  stabile, quindi il runner non produce un falso PASS. Tutti i controlli di
  continuita sono `PASS`; la cattura chiude `SUPPLEMENTAL_FAIL` e il gate
  formale resta `PENDING` in attesa della Postazione;
- B1: due enrollment preesistenti `READY` e coerenti con il registry, senza
  creare nuove identita;
- B2: il diagnostico schema 5 con isteresi ha eseguito `100/100` cicli fra due
  Palmare, con 95 `PASS`, 5 timeout e p95 19.145 ms contro il massimo di 8.000
  ms. Il p95 dopo la disponibilita dei reporter e 14.271 ms; la misura resta
  `NON_GATE_EVIDENCE`, B2 resta `PENDING` e non sostituisce la coppia formale
  Palmare/Postazione;
- B3: non avviato per assenza del tablet Postazione certificato;
- B4: il ledger autorevole corrente contiene `2/10` hardware fisici distinti;
  il runner ibrido simula gli altri otto soltanto in memoria e li conta `0`;
- pilot B5.7: `PENDING` e non autorizzato;
- campagna B5 da 100 sessioni: `PENDING`, `0/100` e non autorizzata;
- B6: `PENDING`, con avvio `BLOCKED` fino alla promozione formale di B5.

Le catture precedenti restano storiche. Le nuove evidenze formali devono usare
la matrice corrente, Palmare `1.0.39` code `40` e Postazione `2.0.23` code `25`,
con inventario, verifica APK/firma e monitor completi. B0-B5 restano `PENDING`
e nessun pilot o campagna B5 e autorizzato dai dati diagnostici.

Nuova evidenza fisica non-gate del 5 agosto con Palmare `1.0.38` code `39`:

- B0 supplementare: scan e advertising `PASS` su entrambi; GATT client/server
  `NOT_PROVEN` su entrambi. Concorrenza scan/advertise, coesistenza Wi-Fi/BLE e
  foreground/background sono `NOT_PROVEN` sul Palmare 1 e `PASS` sul Palmare
  2. La continuita Android e `PASS`; l'esito resta `SUPPLEMENTAL_FAIL`;
- B2 diagnostico: `100/100`, zero cicli falliti, p95 presenza anonima `16.465`
  ms e p95 dopo readiness `12.279` ms, entrambi oltre la soglia di `8.000` ms;
- continuita Raspberry: `PASS` per `1.985.782` ms e `919` campioni, gap massimo
  `6.140` ms, con servizi, boot, clock, restart e polling tutti `PASS`;
- logout finale: finestra nominale `135` secondi ed effettiva di `139`/`142`
  secondi; poller, trasporto, batteria, audio, fatal, ANR, auth, servizi,
  notifiche e waiter server tutti a `0`, con login visibile su entrambi.

Per le catture successive, il B2 usa lo schema 6 con binding SHA-256 canonico
alla matrice certificata. Anche l'attestazione del monitor Raspberry e ora
legata tramite SHA-256 all'intero journal privato finalizzato. Le evidenze
schema precedente restano immutate e non acquisiscono retroattivamente questi
binding.

Il consolidamento finale chiude test root `49/49`, test roadmap `172 PASS`
con `2 SKIP` storici attesi, self-test B2 `133/133`, contratti `22/22`,
manifest bidirezionale e isolamento senza errori. Il validatore conserva i
blocker esterni reali e non consente la promozione.

La Postazione certificata e assente: B0-B5 restano `PENDING` e B6 resta
chiusa.

La procedura completa e in `testing/B5_PHYSICAL_CAMPAIGN_RUNBOOK.md` sotto la
directory della roadmap. Prima di ogni prova fisica si esegue un inventario
read-only di ADB, Raspberry, BlueZ, UPS, servizi, versioni, enrollment e
permessi.

Verifica offline consolidata del 4 agosto: suite Raspberry `196/196`, shared
`124/124`, contratti `22/22`, script roadmap `168 PASS`, `2 SKIP` storici e
zero failure, test root `40/40`, verifica build `9/9`, advertiser Python `7/7`
con self-test `PASS` e archivio sorgente `4/4`. La ricertificazione radio
aggiunge Android `197/197` e `190/190`, coerenza build `9/9`, matrice piu B3
`32/32`, B2 `34/34`, self-test B2 `128/128` e runner B0 `21/21`. Il monitor
Raspberry redatto ha chiuso `PASS` dopo 11.091.818 ms e 5.541 campioni, con
gap massimo 3.490 ms e zero reboot o restart. Questi risultati non promuovono
gate fisici e non modificano il 49% ufficiale.

Ricertificazione del 5 agosto: Palmare Android `210/210`, lint `0` errori e
`23` warning. L'APK Lab Palmare `1.0.38` code `39` ha SHA-256
`c410cae24d5f6663edb9016346842721ea94b944640df49d79ce836a861d1323`.
Due Palmare sono stati aggiornati in-place e la regressione fisica di logout ha
verificato sessioni nuove, revoca token, stop di servizi/notifiche e assenza di
poller, trasporto, batteria e audio. Il controllo finale ha coperto `135`
secondi nominali e `139`/`142` secondi effettivi, con tutti i contatori e i
waiter server a `0`. Il risultato e `PASS / NON_GATE_EVIDENCE`; non promuove i
gate e lascia il 49% ufficiale.

Il dettaglio pubblico della ricertificazione e in
`reports/V5BT_PALMARE_LAB_RECERTIFICATION_20260804.md` nel pacchetto roadmap.
Il confronto delle tre varianti radio e in
`reports/V5BT_B2_RADIO_HYSTERESIS_20260804.md`.
La ricertificazione offline precedente, con addendum del nuovo target, e in
`reports/V5BT_PALMARE_NOTIFICATION_SESSION_RECERTIFICATION_20260805.md`.
La regressione fisica applicativa e in
`reports/V5BT_PALMARE_NOTIFICATION_SESSION_PHYSICAL_REGRESSION_20260805.md`,
con companion pubblico redatto sotto `reports/physical/`.
Il giro fisico B0/B2 corrente e in
`reports/V5BT_B0_B2_TWO_HANDHELD_PHYSICAL_DIAGNOSTIC_20260805.md`.
Inventario finale, B0, B2 e attestazione Raspberry redatti sono in
`reports/physical/`.

## Archivio Sorgente

Lo ZIP portabile viene generato da:

```bash
tools/create-v5bt-source-archive.sh
```

L'archivio include sorgenti, documentazione, lockfile, wrapper di build e dump
SQL sorgente. Esclude APK/AAB, dipendenze, `build`, `dist`, cache Gradle,
asset Android web compilati, archivi annidati, runtime, database runtime,
registry, chiavi, certificati e log privati. Ogni ZIP contiene un manifest
SHA-256 per file e produce un checksum esterno.

L'output corrente e
`V5BT-sorgenti-e-roadmap-rimanente-20260818.zip`, con checksum nel file
affiancato `V5BT-sorgenti-e-roadmap-rimanente-20260818.zip.sha256`. La roadmap
operativa residua e in
`DOCUMENTAZIONE/ROADMAP_RIMANENTE_V5BT_20260817.md`; le snapshot precedenti
sono superate.

## Continuita

Lo stato operativo sintetico e in `DOCUMENTAZIONE/WORKSPACE_ATTIVA.md`; il
passaggio di consegne completo e in `HANDOFF_V5BT_20260724.md`. Le evidenze
storiche mancanti restano dichiarate come esterne e non devono essere
ricostruite o simulate.

## Stato Fisico Corrente Del 5 Agosto 2026

Lo stato piu recente usa Palmare Advanced `1.0.39` code `40`, SHA-256
`d0af2fd9341d5e50b49a4cd68fe4e2a0f70f6d28ef7c0acc1361191b5afffa65`,
e Postazione Advanced `2.0.23` code `25`, SHA-256
`3d55fa75e40e33134c8824b8c36a60d00622ea62528c67db3b74208fbcf868a5`.
La Postazione e compilata e verificata offline, ma il tablet certificato era
assente. Le suite Android chiudono rispettivamente `212/212` e `196/196`, con
lint a zero errori.

Il consolidamento finale chiude test root `49/49`, roadmap Node `300 PASS` con
`2 SKIP` storici attesi, suite Raspberry `196/196`, self-test B2 `140/140` e
Android `212/212` e `196/196`.

B0 supplementare su due Palmare e durato `120` secondi: entrambi chiudono
`6/7`, con PASS per scan, advertising, GATT server, concorrenza,
coesistenza Wi-Fi/BLE e foreground/background. Il GATT client resta
`NOT_PROVEN` senza la Postazione certificata; tutta la continuita Android e
PASS. B0 resta `PENDING`.

Il pilot B2 cooldown chiude `20/20`, zero timeout o errori radio, `20`
quiescenze da almeno `31.000` ms, p95 `5.825` ms, minimo `3.486` ms, massimo
`5.832` ms e p95 dopo readiness `1.940` ms. Il risultato locale e PASS, ma e
`NON_GATE_EVIDENCE`: B2 resta `PENDING`. Il monitor Raspberry chiude PASS con
`758` campioni in `1.517.378` ms, gap massimo `3.720` ms e zero restart.

Il logout finale di `135` secondi chiude a zero auth, servizi nativi target,
notifiche Advanced, tag rilevanti dei processi target, crash, ANR e waiter.
L'inventario post-installazione e incompleto soltanto per il protocollo UPS
non disponibile. B4 non e stato alterato; B5 e B6 restano chiusi.

Il prossimo passo e attendere il tablet Postazione certificato e procedere in
ordine con B0 formale, B1, B2 formale da `100` cicli e B3 da `3.600` secondi.
Il report pubblico redatto e
`reports/physical/V5BT_B0_B2_COOLDOWN_TWO_HANDHELD_PHYSICAL_20260805.md` nel
pacchetto roadmap. L'avanzamento ufficiale resta **49%**.

## Readiness Formale Offline B0-B3 Del 2026-08-05

Il banco offline ora include un runner B0 formale separato, vincolato alla
coppia Palmare `SM-A165F` / Postazione `SM-T503`, alla matrice certificata e a
tutti i sette controlli radio con continuita completa. Campi assenti o non
PASS restano `NON_GATE_EVIDENCE/PENDING`; il dry-run non usa ADB.

B2 formale e passato allo schema `7`: richiede `100` finestre monotone, una
prima di ogni ciclo, tutte da almeno `31.000` ms. Il pilot diagnostico da `20`
cicli rimane separato. Il runbook B3 e aggiornato alle build correnti e alla
verifica del certificato Postazione prima dell'installazione conservativa.

Il tablet non e visibile. B4 non e stato inizializzato: la futura raccolta
ripartira da un nuovo stato privato `0/10`, senza ricostruire il riepilogo
storico non rivalidabile. Verifica corrente: root `49/49`, roadmap
`315 PASS + 2 SKIP`, Raspberry `196/196`, B0 `51/51`, B2 self-test `151/151`,
B3 self-test `41/41` e contratti `22/22`. Report dedicato:
`reports/V5BT_B0_B3_FORMAL_OFFLINE_READINESS_20260805.md` nel pacchetto
roadmap. Avanzamento ufficiale: **49%**.

## Preparazione B4 Con Matrice Certificata Schema 3

La matrice condivisa ora vincola anche il singolo certificato di firma per
Palmare e Postazione. Package, versione, code, SHA-256 APK e pin del
certificato sono consumati da verifier, inventario e gate, senza target
duplicati. Il controllo reale chiude `10/10` PASS.

E stato inizializzato un nuovo stato privato B4 schema `2`, legato al digest
canonico della matrice e ancora a `0/10`. I due preflight non mutanti sui
Palmare collegati hanno correttamente rifiutato reporter non freschi con
`ANDROID_EVIDENCE_STALE`; il ledger e rimasto byte-invariato e nessun device
e stato acquisito.

Sul Raspberry e disponibile una nuova release Lab isolata e inerte con `168`
file piu manifest, permessi restrittivi, zero contenuti privati e nessun
servizio o processo collegato. La release precedente e `SUPERSEDED`. Servizio
principale e Bluetooth sono rimasti attivi e senza restart.

Verifica corrente: root `52/52`, roadmap `320 PASS + 2 SKIP` storici,
Raspberry `196/196`, build reale `10/10`, collector B4 `27 PASS + 2 SKIP` e
self-test PASS. Report pubblico:
`reports/V5BT_B4_MATRIX3_LEDGER_INITIALIZATION_20260805.md` nel pacchetto
roadmap. B4 resta `PENDING` a `0/10`; avanzamento ufficiale **49%**.

## Primo Slot Fisico B4 Monitorato Del 2026-08-05

Il primo hardware della nuova raccolta B4 e stato registrato una sola volta.
Il runner fisico ha chiuso `PASS` dopo `90` secondi con `229` osservazioni
accettate, zero rifiutate, zero errori e cleanup completo. Il monitor Android
ha coperto `120` secondi con `61` campioni e gap massimo `2003` ms; il monitor
Raspberry ha coperto `106063` ms con `22` campioni, gap massimo `5004` ms e
zero restart dei servizi.

Dopo il record, il logout ha riportato il Palmare alla schermata di accesso.
Non risultano notifiche attive o servizi Bluetooth del package e il monitor
canonico restituisce `SESSION_LOGGED_OUT` senza pubblicare attestazioni.
Resta aperta la regressione UI del banner `Configurazione aggiornata.` ancora
visibile al login; l'APK non viene cambiato durante la raccolta per non
invalidare il binding della build certificata nel ledger B4.

Verifica: root `87/87`, monitor Android `19/19`, monitor Raspberry `16/16`,
collector `37 PASS + 2 SKIP` storici, monitored-slot `14/14`, autorevole
`16/16`, catena B4 `67 PASS + 2 SKIP`, integrazione Android
`70 PASS + 2 SKIP`, Raspberry `198/198` e contratti `22/22`. Il ledger e ora
`1/10`, B4 resta `PENDING`, B5 e B6 restano chiusi. Report pubblico redatto:
`reports/V5BT_B4_MONITORED_PHYSICAL_SLOT_1_20260805.md` nel pacchetto roadmap.
Avanzamento ufficiale: **49%**.

## Secondo Slot Fisico B4 Monitorato Del 2026-08-05

Il secondo Palmare distinto e stato acquisito una sola volta tramite il
wrapper monitorato. Il runner B4.3 ha chiuso `PASS` dopo `90` secondi con
`270` osservazioni accettate, zero rifiutate, zero errori e cleanup completo.
Due tentativi con copertura monitor incompleta sono stati scartati senza
modificare lo state.

Il monitor Android valido ha coperto `180` secondi con `91` campioni e gap
massimo `2003` ms. Il monitor Raspberry ha coperto `146657` ms con `30`
campioni, gap massimo `5004` ms, zero restart e cleanup completo. State e
quattro evidenze dello slot sono file regolari `0600` con un solo link fisico.

Dopo il record, il logout ha riportato il Palmare al login con zero notifiche
attive e nessun servizio nativo target. Il monitor canonico ha restituito
`SESSION_LOGGED_OUT`. Servizio principale e Bluetooth sul Raspberry sono
rimasti attivi e invariati; BlueZ ha chiuso senza discovery o advertiser.

Il ledger e ora `2/10` e richiede altri `8` hardware Android distinti. B4
resta `PENDING`, B5 e B6 restano chiusi. Report pubblico redatto:
`reports/V5BT_B4_MONITORED_PHYSICAL_SLOT_2_20260805.md` nel pacchetto roadmap.
Avanzamento ufficiale: **49%**.

## Simulazione Ibrida B4 Del 2026-08-06

Con il ledger fisico fermo a `2/10`, il nuovo runner non-gate ha simulato in
memoria gli slot `3..10`. Ordine, unicita e hash-chain privata sono `PASS`; i
dispositivi sintetici conteggiati verso B4 restano `0`. Lo state fisico e
rimasto identico byte per byte, regolare, `0600` e con un solo link.

Il report esportabile e redatto e non contiene seriali, identita, percorsi,
hash o timestamp fisici. Usa il lock condiviso col collector e pubblica in una
directory non-gate separata, con schema esatto, `0600`, `fsync`, no-overwrite e
rollback. La simulazione non crea manifest, non esegue il gate autorevole e
non autorizza il pilot B5.7 o la campagna B5. B4 e B5 restano `PENDING`, B6
resta `BLOCKED`; servono ancora otto hardware distinti.

Verifica: runner ibrido `7/7 PASS`, self-test `PASS`, suite B5 offline
`159/159 PASS` e consistenza build `10/10 PASS`. Report pubblico:
`reports/V5BT_B4_TWO_PHYSICAL_EIGHT_SIMULATED_NON_GATE_20260806.md` nel
pacchetto roadmap. Avanzamento ufficiale: **49%**.

## Stato Canary LastWrite Coalesce Del 2026-08-07

Il canary fail-safe di `integration.lastWriteAt` e disponibile dietro flag ma
resta ufficialmente OFF. La coda `MAX`, il recovery monotono, le guardie e le
metriche chiudono correttamente; il micro ON completa `300/300` con coda
`91/91`, `71` coalesced e `20` batch. Le prestazioni peggiorano pero da P95
azioni/comande `5853/3652` ms OFF a `9323/8448` ms ON; il tempo lock sale da
`74012` a `120055` ms nonostante i lock wait scendano da `135` a `124`.

ON e respinto, nessuno smoke da `1200` e autorizzato. Prossimo passo:
`NOWAIT` fail-fast con reschedule e confronto A/B/A. Focused `172/172 PASS`,
contratti `100/100 PASS`, gate `7/7 PASS`; full suite backend, rerun isolato:
`1906/1906 PASS`. La prima esecuzione aveva chiuso `1905/1906` con un solo
errore non riprodotto. Nessun hardware usato; B4 `2/10`, B5 `PENDING`, B6
`BLOCKED`, roadmap **49%**. Dettagli in
`DOCUMENTAZIONE/V5BT_LASTWRITE_COALESCE_CANARY_20260807.md`.

## Stato LastWrite NOWAIT A/B/A Del 2026-08-07

Il flush ordinario `integration.lastWriteAt` usa `NOWAIT`, mentre la recovery
di avvio resta bloccante. Le collisioni `3572/ER_LOCK_NOWAIT` e
`1205/ER_LOCK_WAIT_TIMEOUT` sono contention deferral con retry/backoff e
conservazione del `MAX`. Gate lastWrite schema `2` e attestazione lock MySQL
reale sono `PASS`. E stato corretto anche il bug del JSON scalare gia
decodificato dal driver MySQL che poteva permettere la regressione di
`lastWriteAt`.

Il deadlock di bootstrap e stato riprodotto anche combinato; il trace InnoDB
lo ha localizzato sul marker tra chiave `PRIMARY` e gap degli indici. Il fix
separa l'upsert marker e applica il mutex marker solo alle entry nuove, mentre
gli heartbeat esistenti restano paralleli. I test MySQL reali coprono marker
preesistente con `16` coppie, `25` ID nuovi e stesso ID con conservazione del
`MAX`; `INVOCATION_ID` e `JOURNAL_STREAM` sono isolati nei test.

Focused `248/248 PASS`, contratti `103/103 PASS`, stress combinato `10` giri
`50/50 PASS`, blocco ambiente `23/23 PASS`, full suite finale `1918/1918
PASS`. A1 chiude `300/300`, P95 `3212/2247` ms, `115` wait e `30233` ms lock,
`FAIL` anche con un GUI 5xx. B chiude `300/300`, P95
`3490/2165` ms, `104` wait e `15738` ms lock; gate lastWrite `PASS` con `86`
enqueue, `60` coalescenze, `24` batch, `6/6` deferral e zero errori, ma
`FAIL` sul P95 azioni. A2 chiude `300/300`, P95 `2831/2521` ms, `112` wait e
`27851` ms lock: `PASS`.

Contro il midpoint A, B misura azioni `+468,5 ms/+15,51%`, comande `-219
ms/-9,19%` e tempo lock `-45,81%`. Verdetto `REJECTED_ACTION_P95`: flag OFF,
nessuno smoke da `1200`. Evidenze nel bundle
`SORGENTE_SISTEMA/logs/v5bt-lastwrite-nowait-aba-20260807`; manifest A1
`7684907648ca561099d4ab96bda8724658a97e747e4d461ecf046f7f1e85e526`, B
`148d3c3d33d39117f2517df780d0c7968159661bea217f961a00297242df915d`, A2
`dc69dd51149db7b4fac9d0bc376ec6ed38ec80032c97bcb95bba20aaa3948b58` e
aggregato
`ed0fe6f771ad4250d6514deb9ccf6a7db385a4ff462de63020bba1b92f579742`.
Dettagli in `DOCUMENTAZIONE/V5BT_LASTWRITE_NOWAIT_ABA_20260807.md`.

Nessun hardware usato. B4 `2/10`, B5 `PENDING`, B6 `BLOCKED`, roadmap
**49%**.

## Preflight Fisico Complessivo Del 2026-08-10

Il nuovo inventario in sola lettura vede due Palmare conformi alla matrice
certificata `1.0.39/40`, con enrollment `READY`. Le app sono fuori sessione e
i reporter non hanno copertura corrente. Postazione certificata e Raspberry
non sono disponibili, percio il risultato e `INCOMPLETE` e nessun gate e
stato promosso.

Il ledger B4 resta `2/10`; entrambi i Palmare presenti sono gia conteggiati.
Gli artefatti privati B4 sono stati ricondotti a file `0600`, directory `0700`
e zero symlink. Il prossimo passo ammesso e ripetere l'inventario con tutto il
banco, avviare i monitor e completare B0-B3 sulla coppia certificata; servono
poi otto nuovi hardware fisici per chiudere B4. B5 e B6 restano bloccati.

Il runner non puo piu emettere `COMPLETE` con soli Palmare: richiede copertura
esplicita `handheld` e `station`. Il rerun corrente vede entrambi i Palmare e
segnala correttamente Postazione e Raspberry mancanti.

Verifica offline: stato `10/10`, inventario `16/16`, manifest `7/7`, consistenza
build `11/11`, B0 `12/12`, validatore pacchetto e manifest bidirezionale
`PASS`. Il dry-run B0 non ha aperto alcun gate.

Dettagli in
`DOCUMENTAZIONE/V5BT_ROADMAP_PHYSICAL_PREFLIGHT_20260810.md`.

Avanzamento roadmap complessiva: **49%**

## Rehearsal Web B5.7 Del 2026-08-10

Il banco grafico da otto Palmare Chrome supporta ora un rehearsal B5.7
isolato. Il ciclo HTTP loopback ha raggiunto `ACTIVE`, completato `4/4`
PING/PONG e un `CLOSE_ACK`, con zero errori, cleanup completo e sessione
autenticata preservata: `NON_GATE_PASS`.

Il primo tentativo WebSocket fallito per timeout resta conservato privatamente
e non e stato sovrascritto. Suite launcher/pilot `19/19 PASS`; i quattro
self-test canonici B5 chiudono PASS su evidenze esclusivamente sintetiche.

Il rehearsal non usa hardware, non simula Bluetooth/GATT e non registra
sessioni ufficiali. Ledger B4 invariato a `2/10`, B4 e B5 `PENDING`, B5
`0/100`, B6 `BLOCKED`. Dettagli nel runbook e nel report B5 web del pacchetto
roadmap.

Avanzamento roadmap complessiva: **49%**

## Postazione API 31 Compat Del 2026-08-17

La build affiancata corrente e
`com.sentrapa.postazione.advanced.partial`, `2.0.23-api31compat/25`, SHA-256
`c117dad07b1bbff88315770fccc4eba6d13d70ddb200300b901693e1ea636575`.
E stata installata con `adb install -r`: storage, preferenze e identita sono
stati preservati e l'enrollment risulta `READY`.

Il fallback unfiltered limitato all'API 31 non-gate ha confermato il difetto
del filtro ServiceData Samsung. La cattura finale ha raccolto `2.471` callback
grezze, `9` UUID V5BT, `9` payload validi e `36` finestre scan-advertise
concorrenti, p95 `5.735 ms` e zero errori radio. Le richieste HTTPS durante BLE
sono `5/5`; la finestra in background e stabile per `31,253 s`
(`durationMs=31253`), `7` campioni e gap massimo `5,228 s`
(`maxGapMs=5228`).

Una cattura sulla build immediatamente precedente, con sorgenti Bluetooth
identici, ha completato connessione, profilo e MTU `1/1/1`, fermandosi su
`HELLO_WRITE_FAILED` contro lo smoke profile-only. Il retest sull'APK finale ha
registrato `9` tentativi, `6` connessioni e `9` errori, senza una sessione
stabile. Il verdetto resta quindi `NON_GATE_FAIL`. Smoke GATT Raspberry e
cleanup sono `PASS`; il monitor retry 5 e `PASS` per `464,501 s`
(`durationMs=464501`) e `227` campioni, mentre lo staging retry 4 e stabile per
`33,660 s` (`durationMs=33660`) e `20` campioni. Il controllo finale conta
`14` PASS, `gattClientRuntime FAIL` e `gattServerRuntime NOT_RUN`.

La partial generica mantiene cleartext OFF. Soltanto `api31Compat` consente il
trasporto HTTP locale derivato dal portale HTTPS verso il reporter batteria
sulla porta `8865`; non esiste fallback HTTP per frontend, API business o
radio. Il reporter e configurato a `120000 ms` e la ricezione e ripristinata,
con pianificazione ancorata al completamento della notifica precedente. La
misura finale ha osservato `3` notifiche in `270090 ms`, intervalli `120074 ms`
e `121517 ms`: `batteryCadence PASS`.

Report pubblici redatti:
`reports/physical/V5BT_API31_COMPAT_PHYSICAL_NON_GATE_20260817.md` nel pacchetto
roadmap e
`reports/physical/v5bt-api31-compat-physical-non-gate-20260817.json`. Suite
completa `485/485 PASS`, runner report `17/17 PASS`. La prova non promuove
alcun gate.

Avanzamento roadmap complessiva: **49%**

## Workload DOM B4 Su Otto Chrome Del 2026-08-10

Il launcher del banco grafico espone ora anche `--workload`. Il contratto usa
otto sessioni Chrome con emulazione mobile/touch e pianifica `20` azioni DOM
seriali per ciascun Palmare: `160` azioni totali, delle quali `8` invii comanda
per sessione e `64` complessivi. Ogni Palmare mantiene massimo una azione
in-flight, con cadenza azioni di `3000 ms` e media invio comande richiesta fra
`7000` e `8000 ms`. La batteria resta configurata a un solo aggiornamento ogni
`120000 ms`.

Il comando richiede il banco gia `ACTIVE` e fresco, continua a monitorare le
otto pagine e il ledger e produce un risultato privato non sovrascrivibile piu
un report redatto. Non usa ADB, SSH, Bluetooth, GATT, Raspberry o UPS e non
scrive sul ledger fisico, sul collector B5 o sul supervisor della campagna.

Alla chiusura della sezione del 10 agosto il workload live era `NOT_RUN`: non
veniva dichiarato alcun PASS fino alla raccolta e validazione di `160/160`
azioni, `64/64` comande,
cadenze conformi, sessioni preservate, zero errori e ledger byte-identico. Il
ledger autorevole resta `2/10`, gli otto Chrome contano `0`, B4 e B5 restano
`PENDING`, B5 resta `0/100` e B6 resta `BLOCKED`. Dettagli:
`testing/B4_EIGHT_CHROME_GUI_NON_GATE.md` e
`reports/V5BT_B4_EIGHT_CHROME_DOM_WORKLOAD_NON_GATE_20260810.md` nel pacchetto
roadmap.

Avanzamento roadmap complessiva: **49%**

## Chiusura Software Bluetooth B6-B11 Del 2026-08-18

La baseline B6-B11 ha verdetto `SOFTWARE PASS OFFLINE / NON-GATE`, senza
blocker residui nel core transport/software coperto. Non chiude l'intera
roadmap. Comprende elezione ruoli Android, directory di
fiducia e A2 reciproca, DATA/ACK GATT, reliable channel, store schema `3`
legato al peer, route advertisement sequenziato e command bus diagnostico
shadow. I messaggi business restano esclusivamente su `LAN_HTTP_SSE`; route
multi-hop e business BLE non sono abilitati.

Sul Raspberry B9 usa ora un provider health dinamico e un advertiser BlueZ
integrato: health loopback alimenta il solo bit `serverReachable` nel
ServiceData v1, mentre route `LAN/NONE`, RTT e queue depth restano nel frame
affidabile `RouteAdvertisementV1`; health stale o regressivo forza
fail-closed. Alias
privato, `bootId`, rotazione a 60 s e sequenza modulo 256 sono gestiti dal
runtime. Il budget operativo e `<=4750 ms`; batteria e UPS Raspberry restano
`UNKNOWN`. La funzione e OFF per default e non ha ancora evidenza fisica.

I flag di prodotto sono ancora OFF. Lo storico B11 schema 1 resta
`NON_GATE_PASS 4500/4500` su 10 nodi generici e 45 coppie, con digest invariato
`2527641f52ad15459ede6debe628c9dd392b53e774ca39179c59dc95b3adb3a1`.
La baseline storica schema 2 usa 10 Palmari, 3 Postazioni, 1 Raspberry, 1 cassa
automatica e 1 RT, tutti virtualizzati. Ha chiuso `9100/9100`, `2600/2600`
azioni, 800 comande e `100/100` transazioni per ciascuna periferica, con zero
business BT e digest
`6b527f1003329004628dc79abad1db2d2ca607a68551f7030e699abda7ef8f37`.
Raspberry/Node 24 chiude ora `318/318 PASS`; focus B11+helper `17/17`.
Palmare debug e Postazione debug chiudono entrambi 59 classi e `340/340 PASS`,
senza failure, errori o skip. Il watchdog advertiser Postazione
`api31Compat` chiude `7/7 PASS` come test mirato, non come suite full della
variante. Il soak usa tempo virtuale ed e `NON_GATE_EVIDENCE`.

Il nuovo massimo schema 3 usa 2 Palmari fisici e 8 virtuali, 1 Postazione
fisica e 2 virtuali, 1 Raspberry fisico, cassa automatica e RT virtuali. Il
receipt corrente e `MIXED_NON_GATE_INCOMPLETE`: sono osservati `2/4` attori
fisici, precisamente i due Palmari; Postazione e Raspberry risultano `0/1`.
Campagna radio, 600 azioni business fisiche incluse
160 comande, monitor 4/4 e soak wall-clock di almeno due ore sono `NOT_RUN`.
I quattro slot fisici non possono essere sostituiti dai simulatori.

L'assenza di accessi hardware descritta sopra riguarda il run storico schema
2. Il contratto eseguibile schema 3 e read-only,
`MIXED_NON_GATE_INCOMPLETE`-only e non puo emettere un PASS. Readiness 4/4,
`600/600` cicli real-real e tutta la campagna fisica sono criteri per una
futura versione, non attivabile senza manifest/receipt byte-bound, record
per-link e per-actor, timestamp e provenance live. B4 resta `2/10`, B5 `0/100` e B6
`PENDING/BLOCKED`; l'avanzamento ufficiale non cambia.

Nel v3 corrente `WAIVED_NON_GATE` e soltanto metadato per una policy futura e
non rende operativa la readiness. L'inventario certifica l'APK con SHA-256
byte-esatto e deriva la copertura signer dallo stesso binding: firma ignorata
significa APK non certificato e receipt `INCOMPLETE`. Non viene aggiunta una
probe signer separata.

Documento operativo:
`DOCUMENTAZIONE/V5BT_CHIUSURA_SOFTWARE_BLUETOOTH_20260818.md`. Rapporto
tecnico:
`reports/V5BT_B6_B11_SOFTWARE_CLOSURE_NON_GATE_20260818.md` nel pacchetto
roadmap. Report storico schema 2:
`reports/V5BT_B11_MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE_20260818.md`.
Report massimo misto schema 3:
`reports/V5BT_B11_MAXIMUM_MIXED_PHYSICAL_VIRTUAL_NON_GATE_20260818.md`.

Avanzamento roadmap complessiva: **49%**

## Consolidamento Software E Workload Del 2026-08-18

La telemetria periodica aveva portato la suite Raspberry/Node 24 a
`292/292 PASS`, con metriche non osservabili marcate esplicitamente
`UNAVAILABLE`; il successivo consolidamento B5 porta il full corrente a
`303/303 PASS`. Batteria e UPS nel protocollo route restano `UNKNOWN`. La
Postazione `api31Compat` chiude il full offline
`374/374 PASS`, con lint e assemble `PASS`, fix API 24 incluso e
configurazione `NON_INSTALLATA`. Il focus A2 Palmare chiude `18/18 PASS`.

Il commitment account/device B5 e implementato senza usare hardware o
promuovere gate. Il digest canonico domain-separated e redatto nello state
schema `3`, in tutti i `100` record, nell'attestazione Android `1.1`,
nell'aggregate `1.5` e nel receipt `1.1`. La promotion `1.3` ricalcola dal
ledger e dai byte esatti delle due attestazioni i tre digest sorgente e li
confronta con aggregate e receipt. Il percorso legacy resta read-only e
`PENDING`. Verifiche: mirati `83/83 PASS` e Raspberry `303/303 PASS`.

Il badge diagnostico Bluetooth frontend e completato su Palmare e Postazione.
E feature-flagged, resta nascosto senza bridge o evento nativo, usa un parser
bounded fail-closed, rilascia subscription/listener e non espone
identificatori o claim di routing business. Verifiche: Palmare `6/6`,
Postazione `39/39`, typecheck/build `PASS` e quattro viewport.

P-010 e avanzato per tranche senza dichiararne la chiusura complessiva: ha
eliminato lo storage diretto nel perimetro previsto e separato tipi,
normalizzatori e builder puri dal facade analytics, preservando export, HTTP e
payload fiscali. Sono stati inoltre estratti `reservationModel.ts`, la policy
prodotto del composer e il modello puro del dialogo di recovery. I test mirati
chiudono rispettivamente `21/21`, `6/6` e `11/11 PASS` per tree; typecheck e
build sono positivi. Le `38` priorita CSS ridondanti sono state rimosse con
equivalenza visuale verificata, portando il gate `!important` da `305` al
budget `267`. I test architecture chiudono ora `11/12 PASS` per tree: resta
soltanto il gate LOC, con gli stessi quattro monoliti TSX in entrambe le copie.

I nuovi workload DOM del 18 agosto sono immutabili: il primo chiude `160/160`
con `114` successi, `46` failure e conteggio HTTP `565`; il secondo termina in
abort a `87/160`; il terzo chiude `130/160`, con `113` successi, `17` failure,
zero HTTP failure e `stopReason=PAGE_CLOSED`. Il verdetto aggregato resta
`NON_GATE_FAIL` e non sono previsti altri retry. Le correzioni chiudono
`75/75 PASS` e la suite aggiuntiva `55/55 PASS`, ma il residuo sotto carico e
aperto.

La chiusura riguarda quindi il core transport/software: B7-B11 sono
`NON_GATE_PASS` software e `PENDING` fisico. Il meccanismo di commitment B5 e
implementato, ma B5 resta `PENDING`: non e stata raccolta nuova evidenza
hardware e nessun gate e stato promosso.

Avanzamento roadmap complessiva: **49%**
