# Workspace attiva V5BT

Aggiornamento: 2026-08-18, Europe/Rome.

## Percorsi Autorevoli

```text
Workspace:              /home/sentrapa/cassa V5BT
Server e frontend:      SORGENTE_SISTEMA
Palmare Android/React:  APPLICATIVI/Palmare
Postazione Android:     APPLICATIVI/Postazione
Database:               database
Roadmap Bluetooth:      ROADMAP_BLUETOOTH/*/
Runtime locale privato: .runtime/cassav5bt
```

Le baseline e gli archivi storici sono materiale di consultazione. Non sono
directory di sviluppo e non devono essere sincronizzati sul target come
alberi autorevoli.

## Stato Del Banco

Il banco corrente del 17 agosto vede due telefoni Palmare API 36, un tablet
Postazione API 31 non-gate e il Raspberry raggiungibili. Il tablet certificato
API 33 o successivo resta assente. L'inventario fisico read-only comprende:

- ADB e target fisici disponibili;
- package, versioni, SHA-256 installati, Android user e permessi;
- Raspberry, BlueZ, adapter, UPS, NTP e stato dei servizi;
- registry, enrollment e permessi dei file privati;
- `ActiveState`, `SubState`, `MainPID`, `NRestarts`,
  `ActiveEnterTimestampMonotonic` ed `ExecMainStartTimestampMonotonic` di
  `cassav5bt.service` e `bluetooth.service`.

I due Palmare installati sono conformi alla matrice `1.0.39/40`, con identita
distinte ed enrollment `READY`. Sul tablet il package affiancato
`com.sentrapa.postazione.advanced.partial` esegue la variante
`2.0.23-api31compat/25`; installazione, fallback radio e continuita sono
descritti nella sezione finale. Non scegliere un driver UPS o dichiarare
supporto dati prima di avere osservato hardware e protocollo reali.

Il server predefinito Palmare configurato rimane
`https://192.168.1.79:5380/mobile/`. Un valore corrente gia salvato viene
conservato; `192.168.0.67` e `192.168.1.182` vengono migrati come precedenti
default. Le righe seguenti descrivono evidenze storiche e non lo stato corrente
del banco. La build Lab radio usata nelle catture del 4 agosto era Palmare
`1.0.36` code `37` e Postazione `2.0.22` code `24`, entrambe con firma APK v2
valida. Suite Android
`197/197` e `190/190` PASS. L'aggiornamento dei due Palmare e avvenuto con
`adb install -r -g`, senza cancellare dati o enrollment. L'inventario
read-only retry era valido per Android, Raspberry, BlueZ, NTP, servizi,
registry ed enrollment; restava indisponibile soltanto il probe dati UPS.

Il servizio principale non deve essere fermato, riavviato, ricaricato o
ridistribuito durante pilot e campagna Bluetooth. Il monitor della ripresa si
e concluso `PASS` dopo 11.091.818 ms e 5.541 campioni, con gap massimo 3.490 ms
e senza reboot o restart dei servizi osservati.

Nel giro fisico del 5 agosto il nuovo monitor Raspberry ha chiuso `PASS` dopo
`1.985.782` ms e `919` campioni, con gap massimo `6.140` ms. Continuita dei
servizi, boot, clock, assenza restart e copertura polling sono tutti `PASS`.

Nel giro API 31 del 17 agosto il monitor Raspberry retry 5 ha chiuso `PASS`
dopo `464,501 s` (`durationMs=464501`), `227` campioni e gap massimo `5,992 s`
(`maxGapMs=5992`). Il monitor staging retry 4 ha raccolto `20` campioni in
`33,660 s` (`durationMs=33660`), con gap massimo `3,019 s` (`maxGapMs=3019`) e
zero fault di restart, health o hash. Lo smoke GATT Raspberry ha chiuso `PASS`
con cleanup completo; i servizi operativi non sono stati riavviati.

API business, server operativo e database restano invariati. La correzione URL
e inclusa sia nella build Lab installata sia nell'APK normale ricompilato; gli
altri comportamenti applicativi non cambiano.

## Build Android

| Ruolo | Package | Versione | Code | SHA-256 Lab |
| --- | --- | --- | ---: | --- |
| Palmare | `com.sentrapa.palmare.advanced` | `1.0.39` | 40 | `d0af2fd9341d5e50b49a4cd68fe4e2a0f70f6d28ef7c0acc1361191b5afffa65` |
| Postazione | `com.sentrapa.postazione.advanced` | `2.0.23` | 25 | `3d55fa75e40e33134c8824b8c36a60d00622ea62528c67db3b74208fbcf868a5` |

Variante fisica affiancata, esclusa dalla matrice certificata:

| Ruolo | Package | Versione | Code | SHA-256 |
| --- | --- | --- | ---: | --- |
| Postazione API 31 compat | `com.sentrapa.postazione.advanced.partial` | `2.0.23-api31compat` | 25 | `c117dad07b1bbff88315770fccc4eba6d13d70ddb200300b901693e1ea636575` |

Artefatti Lab correnti:
`artifacts/Palmare-Advanced-v1.0.39-V5BT-B0-B2-Cooldown-Lab-20260805-debug.apk`
e
`artifacts/Postazione-Advanced-v2.0.23-V5BT-B0-B2-Cooldown-Lab-20260805-debug.apk`.
Le suite Android chiudono `212/212` e `196/196`, con lint a zero errori. Due
Palmare sono stati aggiornati in-place preservando dati, identita, enrollment
e firma; la Postazione e stata compilata ma il tablet certificato e assente.

Build normali per il ripristino conservativo:

```text
Palmare Advanced 1.0.36 code 37
SHA-256 a1f10e89f0d91be57fe240b9f6295f7c28895448bda14952fd5bc0e5630d5b30

Postazione Advanced 2.0.22 code 24
SHA-256 be297b3223fcbff45ff68245ab049a8c37fc83943376dd4a610d8cd82cc18769
```

Usare soltanto `adb install -r -g`. Non disinstallare, non eseguire
`pm clear` e non cancellare identita o dati enrollati.

## Simulazione Operativa Offline

E disponibile il profilo locale `v5bt-operations-30`, separato dai gate
fisici, per un massimo di 25 Palmare e 5 Postazioni. Nel full ogni device
esegue 200 azioni, per 6.000 azioni totali; lo smoke ne esegue 40 per device,
per 1.200 totali; il micro ne esegue 10 per device, per 300 totali.

La cadenza e di una azione ogni 3 secondi per singolo device. Ogni Palmare
invia comande alternando gap di 9 e 6 secondi: media target 7,5 secondi e gate
fra 7 e 8 secondi. Il catalogo comprende operazioni ordine, storno,
spostamenti tavolo e sala, pagamenti, stampa, notifiche, trasferimenti e
cambio Tavoli/Banco verificato dalla UI reale.

Tutto l'I/O esterno usa mock loopback. Non vengono emulati BLE o hardware e
le azioni fiscali distruttive sono escluse dal profilo ordinario. Il runbook
completo e `SORGENTE_SISTEMA/cassa-frontend/V5BT_OPERATIONS_30_LOADTEST.md`.
Test full, smoke, micro e dry-run restano evidenza applicativa locale e non
cambiano lo stato dei gate o il 49% ufficiale.

I refresh realtime del Palmare sono ora mediati da un coordinatore che
deduplica lo stesso evento, mantiene un solo lavoro attivo e conserva soltanto
l'ultimo trailing. La Postazione coordina allo stesso modo la sincronizzazione
completa e condivide le letture layout concorrenti tramite single-flight. I due
coordinatori cancellano coda e contesto al logout o all'unmount.

Il contratto scheduler v2 misura il dispatch reale: dopo un ritardo il turno
successivo riparte dall'invio effettivo, senza recuperi a raffica. Il gate
applicativo richiede contemporaneamente: zero burst anticipati;
massimo 2 in-flight per device e 60 globali; P95 azioni entro 3.000 ms, P95
comande entro 8.000 ms e massimo assoluto 30.000 ms; budget per GUI e per
singola route layout/ordini pari a `10 + 2 * azioniPerDevice`; zero request
failure, HTTP 5xx ed errori console; persistenza esatta per ogni Palmare senza
perdite o duplicati; retry della stessa comanda con chiave idempotente stabile.
La suite contratti della simulazione e **59/59 PASS**; la batteria mock attesta
un solo aggiornamento ogni **120 secondi**.

### Stato Corrente Del 2026-08-06

Il flush asincrono ordini viene ora inoltrato dai worker API all'owner prima
di leggere l'app-state o acquisire il lock MySQL globale; il fallback locale
resta protetto dal lock. `integration.lastWriteAt` e incluso nella stessa
transazione bulk degli ordini, eliminando la seconda scrittura. Il profilo
canonico disattiva le quattro esclusioni incrociate, usa payment concurrency
`2`, print concurrency `1` e flush ordini ogni `500` ms. Print concurrency `2`
resta una variante diagnostica non promuovibile e viene rifiutata dal gate.

Il micro autorevole
`v5bt_operations_25x5_micro_300_20260806062339_76859e7a94` chiude **PASS** con
**300/300** successi, P95 azioni `2.572` ms, massimo `5.231,17` ms, P95
comande `1.792` ms, cadenza mobile `3.012,58` ms e comande `7.029,77` ms.
Registra `25/25` SSE, picco `24/60`, zero burst, errori GUI o residui e cleanup
completo. Report:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_micro_300_20260806062339_76859e7a94/report.json`.

Lo smoke autorevole
`v5bt_operations_25x5_smoke_1200_20260806062803_b089bfb08e` completa
**1.200/1.200** azioni ma chiude **FAIL**: `1.199` successi, un
`TABLE_LOCKED`, P95 azioni `19.559` ms, massimo `39.122,53` ms, cadenza mobile
`3.632,89` ms e comande `8.963,27` ms. Il P95 comande resta verde a `4.748`
ms, mentre la payment lane registra attesa media `14.219,90` ms e massima
`31.088` ms; `payment.free_split` raggiunge P95 `30.550` ms. Il drain termina
senza residui e il cleanup e completo. Report:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_smoke_1200_20260806062803_b089bfb08e/report.json`.

Il diagnostico
`v5bt_operations_25x5_smoke_1200_diag_payment3_20260806064515` usa payment
concurrency `3` ed e `NON_GATE/NON_PROMOTABLE`. Completa **1.200/1.200** azioni
senza failure o eccezioni, con 16 comande esatte per ciascuno dei 25 Palmari e
drain e cleanup puliti. Rimane **FAIL** per cadenza mobile `3.530,34` ms,
cadenza comande `8.746,91` ms, P95 azioni `14.060` ms e massimo `43.709,53`
ms; P95 comande `5.432` ms e picco `55/60` sono conformi. L'attesa payment
media aggregata e circa `10.236` ms su 107 operazioni, con massimo `33.384`
ms. Rispetto alla concorrenza canonica `2` cala il backlog medio ma crescono
contesa e coda estrema: la variante `3` e respinta e non cambia lo stato.
Report:
`SORGENTE_SISTEMA/logs/loadtest-v5bt_operations_25x5_smoke_1200_diag_payment3_20260806064515/report.json`.

Il retry `order.price_override` e limitato al solo HTTP `409/TABLE_LOCKED`, a
due tentativi totali e con `logicalActionId` e `idempotencyKey` stabili. Gli
altri errori non vengono ritentati e il conflitto persistente resta failure;
test dedicati e di contratto verificano l'intero vincolo.

Il preflight host schema v2 verifica `MemAvailable`, `SwapFree` e load average
a un minuto diviso per le CPU logiche, con massimo `0,75`. Micro e smoke hanno
chiuso `PASS` senza override. Le soglie memoria/swap restano: micro 1 GiB/512
MiB, smoke 3 GiB/2 GiB, full 4 GiB/3 GiB. Un override e attestato ma non puo
qualificare una campagna. Il full resta `NOT_RUN` e bloccato fino a un nuovo
smoke interamente verde.

## Accesso Utenti Per Le Prove

Ogni utente puo essere abilitato indipendentemente per le tre funzioni
`cassa`, `postazione` e `palmare`. Lo stato operativo registrato piu recente
conferma **5/5** utenti abilitati a tutte e tre e alle due Postazioni BAR-1 e
BAR-2. Il database locale di lavoro conferma **14/14** utenti abilitati alle
tre funzioni e a tutte le sei Postazioni attive, con hash record validi.

La fixture 25+5 crea inoltre 30 utenti sintetici, tutti abilitati alle tre
funzioni e alle cinque Postazioni di test. Per verificare o riallineare il
database locale usare prima il dry-run e poi, solo quando richiesto, la
modalita transazionale:

```bash
npm run admin:enable-all-user-apps
npm run admin:enable-all-user-apps -- --apply
```

I backup pre-modifica sono privati, non sovrascrivibili, con permessi `0600`
in `.runtime/cassav5bt/user-access-backups` e non devono entrare negli archivi.

## Stato Roadmap

```text
Avanzamento ufficiale: 49%
B0 supplementare:     SUPPLEMENTAL_FAIL, continuita PASS, PENDING
B1 due Palmare:       READY, registry coerente
B2 pilot cooldown:    20/20, p95 5825 ms, NON_GATE, PENDING
B3:                   PENDING, tablet assente
B4 ledger corrente:   2/10 fisici; 8 simulati contano 0, PENDING
Pilot B5.7:            PENDING, non autorizzato
Rehearsal web B5.7:    NON_GATE_PASS, 0 sessioni ufficiali
Campagna B5:           PENDING, non autorizzata, 0/100 ufficiali
B6:                    PENDING, avvio BLOCKED
B7-B11 software:       NON_GATE_PASS, fisico PENDING
Carico applicativo:   micro PASS, smoke FAIL, full NOT_RUN
```

Lo stato sopra e vincolato a Palmare `1.0.39` code `40` e Postazione `2.0.23`
code `25` ed e pubblicato dalla fonte unica `configs/current-roadmap-status.json`
del pacchetto roadmap. Nessuna evidenza diagnostica o simulata puo autorizzare
il pilot o la campagna B5. B0-B5 restano `PENDING`.

Preparazione offline completata:

- matrice di certificazione condivisa tra i gate;
- B2/B3 allineati alle build Lab correnti;
- collector B5 con stato v2, `bootId` privato e recovery fail-closed;
- monitor ADB continuo e attestazione redatta; il gate ammette soltanto il
  ruolo `handheld` e la copertura va dal primo all'ultimo tentativo, non solo
  tra le sessioni concluse con successo;
- supervisor B5 con ledger tentativi schema v1 separato, hash-chain, recovery
  e file `0600`;
- retry automatico solo per `DIRECT_CONTROL_ORCHESTRATION_TIMEOUT` con cleanup
  verificato; tre timeout sospendono, ogni altro errore invalida;
- resume con clock regressivo trasformato in invalidazione registrata nel
  ledger;
- monitor Raspberry continuo e attestazione redatta per due servizi, boot e
  clock;
- scheduling Android corretto per durate non multiple del polling e deadline
  finale rispettata;
- pubblicazione accoppiata e recuperabile del risultato privato e della sua
  attestazione redatta per i monitor Android e Raspberry;
- inventario unico read-only del banco, con UPS soltanto discovery;
- verificatore di matrice/Gradle/APK e parita Bluetooth condivisa;
- autorizzazione B0-B4 e review indipendente vincolata all'hash aggregato;
- gate tecnico con parsing esatto e fail-closed, legato a state, manifest,
  ledger e attestazioni Android e Raspberry della stessa campagna;
- receipt tecnico privato che vincola l'aggregato esatto alla campagna e alle
  evidenze di collector, supervisor, autorizzazione e monitor;
- preflight, checklist, stop conditions e rollback documentati;
- manifest sorgente bidirezionale e generatore dell'archivio riproducibile.

Il gate tecnico puo produrre `TECHNICAL_PASS`, ma mantiene B5
`PENDING_REVIEW` e B6 `PENDING`. Soltanto il promotion gate, dopo sign-off di
un revisore distinto legato allo SHA-256 esatto dell'aggregato e verifica del
receipt tecnico privato, puo promuovere B5 a PASS. Receipt assente, alterato o
appartenente a un'altra campagna lascia B5 `PENDING`.

Verifica offline consolidata del 4 agosto: suite Raspberry `196/196`, shared
`124/124`, contratti operativi `47/47`, script roadmap `168 PASS`, `2 SKIP` storici e
zero failure, test root `40/40`, verifica build `9/9`, advertiser Python `7/7`
con self-test `PASS` e archivio sorgente `4/4`. Nessuno di questi PASS
promuove un gate fisico.

Ricertificazione radio del 4 agosto: suite Android `197/197` sul Palmare e
`190/190` sulla Postazione, coerenza build `9/9`, matrice piu B3 `32/32`, B2
`34/34`, self-test B2 `128/128` e runner B0 `21/21`. L'isteresi mantiene advertising
`LOW_LATENCY` per 8 secondi dalla prima osservazione valida; duplicati e update
non estendono la deadline, mentre FAILOVER, stop e cambio generazione la
invalidano. La race di scheduling distingue `ABORTED` da `FAILED`.

Ricertificazione sessione notifiche del 5 agosto: Palmare Android `210/210` e
lint `0` errori e `23` warning. Due Palmare aggiornati in-place hanno chiuso la
regressione fisica di logout con sessioni nuove HTTP `200`, epoch ruotati,
token precedenti e revocati HTTP `401`, servizi/notifiche a `0` e osservazione
post-logout di `135` secondi senza poller, trasporto, batteria, audio, fatal o
ANR nel perimetro package/UID. Il risultato e `NON_GATE_EVIDENCE`, quindi non
promuove gate fisici e non modifica il 49%.

Nel giro storico del 4 agosto il B0 supplementare registrava su entrambi i
Palmare PASS per scan, advertising, concorrenza, coesistenza Wi-Fi/BLE e
foreground/background. Client e server GATT erano `FAIL/NOT_PROVEN`, mentre
tutti i controlli di continuita erano PASS. Il B2 aveva completato `100/100`
cicli con 95 PASS, 5 timeout e p95 19.145 ms. Questi valori restano soltanto
storici.

Nel giro corrente del 5 agosto B0 registra scan e advertising `PASS` su
entrambi e continuita Android `PASS`. GATT client/server sono `NOT_PROVEN` su
entrambi; concorrenza, coesistenza Wi-Fi/BLE e foreground/background sono
`NOT_PROVEN` sul Palmare 1 e `PASS` sul Palmare 2. L'esito e
`SUPPLEMENTAL_FAIL`. B2 completa `100/100` cicli con zero falliti, ma il p95
presenza anonima e `16.465` ms e quello dopo readiness `12.279` ms, oltre la
soglia di `8.000` ms: resta `NON_GATE_EVIDENCE/PENDING`. Il report pubblico e
`reports/V5BT_B0_B2_TWO_HANDHELD_PHYSICAL_DIAGNOSTIC_20260805.md` nella
roadmap.

I contratti delle prossime catture sono stati irrobustiti senza riscrivere le
evidenze esistenti: B2 passa allo schema 6 con binding SHA-256 canonico alla
matrice certificata; il monitor Raspberry inserisce nell'attestazione redatta
lo SHA-256 dell'intero journal privato finalizzato. La diagnosi corrente indica
inoltre che B0 deve separare probe GATT server open/close e client verso
Raspberry, e deve sostituire il campionamento puntuale della concorrenza con un
contatore cumulativo.

Consolidamento corrente: test root `49/49`, test roadmap `172 PASS` e
`2 SKIP` storici attesi, self-test B2 schema 6 `133/133`, contratti
`22/22`, manifest bidirezionale `PASS` e zero errori di isolamento.

La percentuale non aumenta con test locali o fixture sintetiche. Servono nuove
evidenze fisiche di gate valide acquisite con Palmare `1.0.39` e revisione
indipendente.

## Sequenza Residua

1. Alla disponibilita della Postazione certificata, ripetere l'inventario
   unico read-only e mantenere l'UPS in sola discovery senza assumere un
   driver.
2. Verificare che Palmare `1.0.39` sia ancora installato con hash, firma,
   package e identity corretti; installare conservativamente la Postazione
   certificata senza cancellare dati o enrollment.
3. Completare B0-B3 con la coppia Palmare/Postazione; il diagnostico fra due
   Palmare non sostituisce questi gate. B4 puo ripartire soltanto da uno state
   privato autentico e integro.
4. Eseguire un solo pilot B5.7 diagnostico in stato separato.
5. Solo dopo il PASS B0-B4 inizializzare collector state e ledger supervisor,
   quindi emettere l'autorizzazione della stessa campagna.
6. Acquisire le baseline e avviare monitor Android e Raspberry continui prima
   del primo tentativo; il target Android deve essere il Palmare con ruolo
   `handheld`.
7. Raccogliere `001..100` esclusivamente tramite supervisor; un timeout
   ritentabile non incrementa lo slot.
8. Finalizzare collector e attendere il PASS naturale di entrambi i monitor.
9. Eseguire il gate tecnico con manifest, state, ledger, autorizzazione e due
   attestazioni; conservare anche il receipt tecnico privato:
   `TECHNICAL_PASS` lascia B5 `PENDING`.
10. Ottenere sign-off indipendente, eseguire il promotion gate fornendo il
    receipt della stessa campagna e poi
    ripristinare le build normali senza riavviare il servizio principale.
11. Avviare B6 soltanto dopo la promozione formale di B5.

## Archivio Portabile

Il nuovo archivio sorgente si genera con:

```bash
tools/create-v5bt-source-archive.sh
```

Non include APK, dipendenze, output di build, cache, archivi annidati, runtime,
registry, database runtime, chiavi, certificati o log privati. Nome e SHA-256
sono pubblicati nella root nello ZIP e nel file `.zip.sha256` affiancato.

Snapshot corrente: `V5BT-sorgenti-e-roadmap-rimanente-20260818.zip`, con
checksum in `V5BT-sorgenti-e-roadmap-rimanente-20260818.zip.sha256`. La
roadmap residua e riepilogata in
`DOCUMENTAZIONE/ROADMAP_RIMANENTE_V5BT_20260817.md`; le snapshot precedenti
sono superate.

## Aggiornamento Fisico Prevalente Del 2026-08-05

Questo aggiornamento sostituisce operativamente i riferimenti precedenti alle
build Lab per le prossime catture. La matrice corrente fissa Palmare Advanced
`1.0.39` code `40`, SHA-256
`d0af2fd9341d5e50b49a4cd68fe4e2a0f70f6d28ef7c0acc1361191b5afffa65`,
e Postazione Advanced `2.0.23` code `25`, SHA-256
`3d55fa75e40e33134c8824b8c36a60d00622ea62528c67db3b74208fbcf868a5`.
Le suite Android sono `212/212` e `196/196`, con lint a zero errori. Il tablet
Postazione non era disponibile e la sua build non e stata installata.

Consolidamento finale corrente: test root `49/49`, roadmap Node `300 PASS` e
`2 SKIP` storici attesi, suite Raspberry `196/196`, self-test B2 `140/140` e
suite Android `212/212` e `196/196`.

B0 supplementare di `120` secondi chiude `6/7` su entrambi i Palmare: scan,
advertising, server GATT, concorrenza, coesistenza Wi-Fi/BLE e lifecycle sono
PASS; client GATT `NOT_PROVEN`; continuita interamente PASS. Il pilot B2
cooldown chiude `20/20`, zero timeout/errori, venti quiescenze da almeno
`31.000` ms, p95 `5.825` ms, range `3.486..5.832` ms e p95 post-readiness
`1.940` ms. Entrambe le prove sono `NON_GATE_EVIDENCE` e lasciano B0/B2
`PENDING`.

Il monitor Raspberry e PASS su `758` campioni, `1.517.378` ms e gap massimo
`3.720` ms, senza reboot o restart. Il logout di `135` secondi registra zero
auth, servizi nativi target, notifiche Advanced, tag processo rilevanti,
crash, ANR e waiter. L'inventario e incompleto soltanto per
`UPS_DISCOVERY_UNAVAILABLE`.

B4 non e stato alterato. B5 e B6 restano chiusi. Alla disponibilita del tablet
Postazione certificato: inventario read-only, B0 formale, B1, B2 formale da
`100` cicli e B3 da `3.600` secondi, in quest'ordine. Report pubblico:
`reports/physical/V5BT_B0_B2_COOLDOWN_TWO_HANDHELD_PHYSICAL_20260805.md` nel
pacchetto roadmap. Avanzamento ufficiale: **49%**.

## Stato Offline Formale B0-B3 Del 2026-08-05

Runner B0 formale disponibile e separato dal diagnostico: coppia fissa
Palmare `SM-A165F` / Postazione `SM-T503`, matrice certificata, sette controlli
radio, continuita completa e fail-closed. Dry-run senza ADB.

B2 schema `7`: `100` quiescenze monotone da almeno `31.000` ms, una prima di
ogni ciclo formale. Pilot da `20` cicli invariato e non-gate. B3 aggiornato
alle versioni `1.0.39` code `40` e `2.0.23` code `25`; prima dell'installazione
Postazione e obbligatorio confrontare il certificato dell'APK installato con
quello target.

ADB vede soltanto i due Palmare; Raspberry e servizi sono attivi. B4 non e
stato inizializzato perche il vecchio `1/10` non e rivalidabile e le sessioni
radio non sono fresche. Il nuovo run partira da `0/10` in area privata dopo
l'allineamento isolato del runtime Lab Raspberry. Test: root `49/49`, roadmap
`315 PASS + 2 SKIP`, Raspberry `196/196`, B0 `51/51`, B2 `151/151`, B3
`41/41`, contratti `22/22`. Avanzamento ufficiale: **49%**.

## Stato B4 Preparato Del 2026-08-05

Matrice certificata schema `3`: package, versione, code, SHA-256 APK e pin del
singolo certificato sono centralizzati e verificati fail-closed. Il nuovo
state B4 privato e schema `2`, legato alla matrice e inizializzato a `0/10`;
nessuna evidenza storica e stata importata.

ADB vede due Palmare conformi. Entrambi sono disconnessi dall'app e i due
preflight read-only hanno prodotto `ANDROID_EVIDENCE_STALE`, senza modificare
lo state. Il tablet Postazione non e presente.

Sul Raspberry usare esclusivamente la seconda release Lab `matrix3-r2`. La
prima e `SUPERSEDED`. La release corrente contiene `168` file piu manifest,
ha binding matrice corretto, permessi restrittivi e nessun contenuto privato,
servizio o processo associato. Servizio principale e Bluetooth restano attivi
e senza restart.

Prossima azione fisica: login su un solo Palmare, reporter fresco, monitor
continui, B4.3 da almeno `90` secondi, cleanup verificato e record dello slot
`1/10`. Non avviare B5 e non promuovere B4 prima di `10/10` hardware distinti.

Verifica: root `52/52`, roadmap `320 PASS + 2 SKIP`, Raspberry `196/196`,
build reale `10/10`, collector B4 `27 PASS + 2 SKIP`. Report pubblico:
`reports/V5BT_B4_MATRIX3_LEDGER_INITIALIZATION_20260805.md` nella roadmap.
Avanzamento ufficiale: **49%**.

## Banco B4 Web Grafico Del 2026-08-10

Il workspace contiene ora il launcher
`SORGENTE_SISTEMA/cassa-frontend/scripts/run-v5bt-b4-web-gui-lab.mjs`. Avvia
otto finestre Chrome Palmare Advanced isolate per gli slot `3..10`, con
account di test distinti e PIN `1234`, backend/frontend su loopback e nessun
accesso all'hardware.

Il banco verificato e `ACTIVE` con `8/8` finestre, pagine e sessioni,
`SIMULATED_10_OF_10`, screenshot privati `0600` e suite `10/10 PASS`. Stato e
artefatti restano in `.runtime/cassav5bt/b4-web-gui`, quindi non entrano negli
archivi sorgente. Il ledger fisico viene controllato in sola lettura ogni
cinque secondi ed e rimasto identico a `2/10`.

Il launcher supporta anche `--workload`, riservato a un banco gia `ACTIVE` e
fresco. Il profilo vincolante usa otto Chrome mobile/touch, `20` azioni DOM per
Palmare (`160` totali), `8` comande per Palmare (`64` totali), massimo una
azione concorrente per sessione, cadenza azioni `3000 ms` e media comande fra
`7000` e `8000 ms`. Il reporting batteria resta limitato a una volta ogni
`120000 ms`.

Richiesta e risultato sono privati `0600`, non sovrascrivibili e legati da
commitment; lo stato pubblico e redatto. Il monitor del banco continua durante
il workload e invalida la prova per sessione persa, errore, conteggio o cadenza
fuori contratto oppure variazione del ledger. Alla chiusura del 10 agosto
l'esecuzione live da `160/64` era `NOT_RUN`, quindi non veniva dichiarato
alcun PASS del workload.

Questa chiude soltanto la copertura GUI simulata: B4 e B5 restano `PENDING`,
B6 `BLOCKED` e gli otto web contano `0` nel gate fisico.

Contratto e stato verifica:
`testing/B4_EIGHT_CHROME_GUI_NON_GATE.md` e
`reports/V5BT_B4_EIGHT_CHROME_DOM_WORKLOAD_NON_GATE_20260810.md` nel pacchetto
roadmap.

Avanzamento ufficiale: **49%**.

## Stato Canary Marker Station-State Del 2026-08-06

Il canary MySQL station-state e implementato dietro flag, disattivato per
default e nel deploy ufficiale. Marker assente o corrotto usa il fallback
canonico autoriparante; il report richiede esercizio del ramo, contabilita
completa e zero rollback. Suite integrata `318/318 PASS`, inclusi test InnoDB
reali su ID distinti, stesso ID e bootstrap concorrente.

ON diagnostico: `300/300`, zero errori business, audit marker `PASS`, P95
azioni `3183` ms e quindi FAIL. OFF ufficiale: `300/300`, zero errori, tutti i
gate PASS, P95 azioni `1793` ms e comande `1535` ms. La variante ON e respinta
e non autorizza uno smoke. Dettagli e SHA-256 in
`V5BT_STATION_STATE_MARKER_CANARY_20260806.md`.

Nessun hardware fisico usato e nessun processo o swap temporaneo residuo. B4
`2/10`, B5 `PENDING`, B6 `BLOCKED`.

Avanzamento ufficiale: **49%**.

## Stato Attribution Owner E Batching Del 2026-08-06

Metriche owner/spool/station-state rese stabili e incluse nel nuovo gate
`latencyAttribution` schema `1`. Il gate e fail-closed su raccolta worker,
metriche mancanti, mismatch cardinali e label dinamiche; entrambe le catture
odierne hanno chiuso attribution `COMPLETE` su quattro categorie e `6/6`
worker. Suite integrata: `241/241 PASS`.

Configurazione ufficiale invariata a `25` ms. Il canary `100` ms e consentito
solo come `NON_GATE/NON_PROMOTABLE` e ha fallito il P95 azioni: `4166` ms su
limite `3000` ms, pur completando `300/300` azioni senza errori business. La
ripetizione `25` ms ha subito contesa station-state fino a `12747` ms e ha
fallito P95/cadenze; non promuove readiness. Nessuno smoke autorizzato.

Decisione: respingere `100` ms, mantenere `25` ms, affrontare nel prossimo
passo offline il lock MySQL condiviso di station-state. Report e hash completi
sono registrati in `HANDOFF_V5BT_20260724.md`. Nessun hardware usato e nessun
processo di simulazione residuo.

Avanzamento ufficiale: **49%**.

## Stato B4 Monitorato Del 2026-08-05

La preparazione offline B4 e completa. Monitor Android `1.0.2` e Raspberry, collector,
wrapper di slot e gate Raspberry autorevole condividono collection, capture e
matrice certificata e operano fail-closed. Il manifest privato e schema `2` e
include per ogni slot i riferimenti e gli SHA-256 delle due attestazioni.

Il primo slot fisico e stato registrato con Palmare Advanced `1.0.39` code
`40`, Android API `36`, modello `SM-A165F`. Runner B4.3 `PASS` dopo `90`
secondi: `229` osservazioni accettate, zero rifiutate, zero errori e cleanup
completo. Eventuali tentativi respinti prima del record non sono conteggiati.

Monitor Android `PASS`: `120` secondi, `61` campioni, gap massimo `2003` ms.
Monitor Raspberry `PASS`: `106063` ms, `22` campioni, gap massimo `5004` ms,
zero restart dei servizi e cleanup completo. Il logout successivo ha lasciato
zero notifiche attive e zero servizi Bluetooth del package; il monitor
canonico ha restituito `SESSION_LOGGED_OUT` senza attestazione.
Il banner `Configurazione aggiornata.` resta visibile anche sulla schermata di
accesso ed e ancora una regressione UI aperta. La build certificata non va
cambiata a raccolta B4 iniziata senza inizializzare una nuova matrice e un
nuovo ledger.

Test: root `87/87`, monitor Android `19/19`, monitor Raspberry `16/16`,
collector `37 PASS + 2 SKIP` storici, monitored-slot `14/14`, gate autorevole
`16/16`, catena B4 `67 PASS + 2 SKIP`, integrazione Android
`70 PASS + 2 SKIP`, Raspberry `198/198` e contratti `22/22`.

Lo state privato e ora `1/10`, B4 resta `PENDING` e richiede altri `9`
hardware distinti. B5 e B6 restano chiusi. Report pubblico:
`reports/V5BT_B4_MONITORED_PHYSICAL_SLOT_1_20260805.md` nella roadmap.
Avanzamento ufficiale: **49%**.

## Stato B4 Slot 2 Del 2026-08-05

Il secondo Palmare distinto e stato registrato nel medesimo state privato
schema `2`. Il runner valido e `PASS`: `90` secondi, `270` osservazioni
accettate, zero rifiutate, zero errori e cleanup completo. Due tentativi con
copertura incompleta sono stati classificati `EVIDENCE_NOT_RECORDED` e non
hanno modificato il ledger.

Monitor Android `PASS`: `180` secondi, `91` campioni, gap massimo `2003` ms.
Monitor Raspberry `PASS`: `146657` ms, `30` campioni, gap massimo `5004` ms,
zero restart e cleanup completo. I file dello state e dello slot sono
regolari, `0600` e con un solo link fisico.

Post-run: servizi Raspberry attivi e invariati, BlueZ non in discovery e zero
advertiser. Il Palmare e stato disconnesso, e tornato al login e presenta zero
notifiche attive e zero servizi nativi target; verifica canonica
`SESSION_LOGGED_OUT`.

Stato corrente: `2/10`, B4 `PENDING`, altri `8` hardware distinti necessari.
B5 e B6 restano chiusi. Report pubblico:
`reports/V5BT_B4_MONITORED_PHYSICAL_SLOT_2_20260805.md` nella roadmap.
Avanzamento ufficiale: **49%**.

## Stato Simulazione Ibrida Del 2026-08-06

Il ledger privato resta autorevolmente `2/10`. Un runner offline separato ha
usato quei due record in sola lettura e otto elementi sintetici in memoria per
verificare il flusso logico completo: ordine, unicita, hash-chain e redazione
sono `PASS`. Lo state e rimasto identico byte per byte; test runner `7/7 PASS`.

Gli otto simulati non sono persistiti e contano `0` verso il gate. Non sono
stati creati manifest o nuove evidenze e non e stata eseguita alcuna
promozione. Il runner condivide il lock del collector e consente output solo
in una directory privata e separata, con schema esatto e rollback atomico. B4
e B5 restano `PENDING`, B6 resta `BLOCKED`; il pilot B5.7 non e autorizzato
finche non passano i prerequisiti fisici. Report pubblico:
`reports/V5BT_B4_TWO_PHYSICAL_EIGHT_SIMULATED_NON_GATE_20260806.md`.
Avanzamento ufficiale: **49%**.

## Stato Canary Contesa Ordini Del 2026-08-06

Tre ottimizzazioni sperimentali del flush asincrono ordini sono disponibili
soltanto dietro flag diagnostici: MySQL `NOWAIT`, separazione di
`integration.lastWriteAt` e separazione sicura di `sequence`. La
configurazione ufficiale, il runner qualificabile e il deploy systemd le
mantengono tutte disattivate.

I canary da `300` operazioni hanno preservato correttezza, auto-print owner,
drain e cleanup, ma hanno fallito il limite P95 azioni di `3000` ms:
`5626` ms con NOWAIT, `3149` ms con il solo `lastWriteAt` separato e `6716`
ms separando anche `sequence`. Anche la ripetizione stabile completamente OFF
ha misurato `3422` ms. I P95 comande sono rimasti tutti sotto il limite di
`8000` ms. Nessuno smoke da `1200` e stato quindi autorizzato.

La suite allargata mirata e `231/231 PASS`. Report, hash e decisione completa
sono registrati in `HANDOFF_V5BT_20260724.md`. Il prossimo passo offline deve
concentrarsi sul lavoro caldo dell'owner e sull'interazione tra spool di
stampa e stato postazione. Non sono state usate evidenze hardware: B4 resta
`2/10`, B5 `PENDING`, B6 `BLOCKED`.

Avanzamento ufficiale: **49%**.

## Stato Workspace Finale Del 2026-08-06

Il canary fail-safe del marker MySQL station-state e completo; suite integrata
`318/318 PASS`, test InnoDB reali PASS e audit schema `1` attivo. L'ON
diagnostico e respinto a P95 azioni `3183` ms; l'OFF ufficiale passa a `1793`
ms, con P95 comande `1535` ms. Restano ufficiali marker OFF e owner auto-print
a `25` ms. Dettagli in `V5BT_STATION_STATE_MARKER_CANARY_20260806.md`.

Prossimo intervento offline: smoke qualificabile da `1200` operazioni sul
profilo OFF. Non avviare il full senza il PASS dello smoke.

Nessun hardware usato. B4 `2/10`, B5 `PENDING`, B6 `BLOCKED`.

Avanzamento ufficiale: **49%**.

## Stato Smoke 1200 Isolato Del 2026-08-06

Il banco di prova ora usa spool stampa dedicato al singolo report, cleanup
bloccante e backend vincolati a `127.0.0.1`. Default operativo invariato.
Verifiche statiche PASS, contratti V5BT `86/86 PASS` e gate architetturale
backend `143/143 PASS`; preflight enforced e binding live loopback PASS.

Lo smoke ufficiale
`v5bt_operations_25x5_smoke_1200_off_isolated_202608061541` ha completato
`1200/1200` azioni ma e `FAIL`: 6 azioni fallite, P95 azioni `17358 ms`, P95
comande `8167 ms`, massimo `54134,22 ms`, cadenze fuori gate e 4 comande
persistite mancanti senza duplicati. Drain, audit owner/marker, attribution,
GUI e cleanup sono PASS.

Diagnosi: `450` attese InnoDB per `697149 ms`, con station-state e proxy owner
a P95 `10000 ms`, dispatch P95 `5793 ms` e backpressure `60/60`. Evidenza
sigillata; SHA-256 manifest
`b614357ca690dde05dc27ddafb2d4122460d7d1764655c3e3c4f71e323adaf93`.
Zero residui del run; spool storico invariato; rimosse soltanto le sue sei
tabelle MySQL e lo swap temporaneo.

Prossimo passo offline: canary fail-safe sulla contesa della riga
`integration.lastWriteAt` e sul lock ordering, quindi micro ufficiale. Full
vietato fino al PASS smoke. B4 `2/10`, B5 `PENDING`, B6 `BLOCKED`.

Avanzamento ufficiale: **49%**.

## Stato Canary LastWrite Coalesce Del 2026-08-07

Il canary fail-safe di `integration.lastWriteAt` implementa coda sul `MAX`,
recovery monotono all'avvio, reinserimento dopo errore, writer transazionale,
drain di chiusura e guardia che esclude presenza, login/logout e notifiche.
Le metriche diagnostiche attestano enqueue, coalescing, batch, flush, retry,
errori, recovery e stato della coda. Default e deploy ufficiale restano OFF.

Il micro OFF completa `300/300` con P95 azioni `5853` ms, P95 comande `3652`
ms, `135` lock wait e `74012` ms di tempo lock. Il micro ON completa
`300/300` con P95 azioni `9323` ms, P95 comande `8448` ms, `124` lock wait e
`120055` ms di tempo lock; coda `91/91`, `71` coalesced e `20` batch.

La variante ON e respinta per prestazioni. Nessuno smoke da `1200` e
autorizzato. Prossimo passo: `NOWAIT` fail-fast con reschedule esplicito e
confronto A/B/A. Focused `172/172 PASS`, contratti `100/100 PASS`, gate `7/7
PASS`; full suite backend, rerun isolato: `1906/1906 PASS`. La prima
esecuzione aveva chiuso `1905/1906` con un solo errore non riprodotto.
Evidenze e SHA-256 sono in
`V5BT_LASTWRITE_COALESCE_CANARY_20260807.md`.

Nessun hardware usato. B4 `2/10`, B5 `PENDING`, B6 `BLOCKED`.

Avanzamento ufficiale: **49%**.

## Stato LastWrite NOWAIT A/B/A Del 2026-08-07

Il flush ordinario di `integration.lastWriteAt` usa ora `NOWAIT`; la recovery
di avvio resta bloccante. MySQL `3572/ER_LOCK_NOWAIT` e MariaDB
`1205/ER_LOCK_WAIT_TIMEOUT` sono contention deferral con retry/backoff e
reinserimento del `MAX`. Il gate schema `2` e l'attestazione lock MySQL reale
sono `PASS`. E stato inoltre corretto il caso in cui un JSON scalare gia
decodificato dal driver MySQL poteva rendere invalido il confronto e
permettere una regressione di `lastWriteAt`.

Il deadlock di bootstrap e stato riprodotto anche nello stress combinato. Il
trace InnoDB ha mostrato contesa sul marker tra chiave `PRIMARY` e gap degli
indici. Il fix separa l'upsert marker e limita il mutex marker alle entry
nuove; gli heartbeat esistenti restano paralleli. I test MySQL reali coprono
marker preesistente con `16` coppie, `25` ID nuovi e stesso ID con
conservazione del `MAX`; i test isolano `INVOCATION_ID` e `JOURNAL_STREAM`.

Verifica: focused `248/248 PASS`, contratti `103/103 PASS`, stress combinato
`10` giri `50/50 PASS`, blocco ambiente `23/23 PASS`, full suite finale
`1918/1918 PASS`. A1: `300/300`, P95 azioni/comande `3212/2247` ms, `115`
wait, `30233` ms lock, `FAIL` anche con un GUI 5xx. B:
`300/300`, `3490/2165` ms, `104` wait, `15738` ms lock, gate lastWrite `PASS`
con `86` enqueue, `60` coalescenze, `24` batch, `6/6` deferral e zero errori,
ma `FAIL` sul P95 azioni. A2: `300/300`, `2831/2521` ms, `112` wait, `27851`
ms lock, `PASS`.

Contro il midpoint A, B misura P95 azioni `+468,5 ms/+15,51%`, P95 comande
`-219 ms/-9,19%` e tempo lock `-45,81%`. Verdetto
`REJECTED_ACTION_P95`: flag operativo OFF e nessuno smoke da `1200`.

Manifest A1
`7684907648ca561099d4ab96bda8724658a97e747e4d461ecf046f7f1e85e526`, B
`148d3c3d33d39117f2517df780d0c7968159661bea217f961a00297242df915d`, A2
`dc69dd51149db7b4fac9d0bc376ec6ed38ec80032c97bcb95bba20aaa3948b58`;
aggregato
`ed0fe6f771ad4250d6514deb9ccf6a7db385a4ff462de63020bba1b92f579742`.
Bundle: `SORGENTE_SISTEMA/logs/v5bt-lastwrite-nowait-aba-20260807`; report:
`V5BT_LASTWRITE_NOWAIT_ABA_20260807.md`.

Nessun hardware usato. B4 `2/10`, B5 `PENDING`, B6 `BLOCKED`.

Avanzamento ufficiale: **49%**.

## Preflight Fisico Complessivo Del 2026-08-10

L'inventario read-only corrente termina `INCOMPLETE`: sono collegati due
Palmare conformi alla matrice `1.0.39/40`, con permessi ed enrollment `READY`,
ma fuori sessione e senza reporter corrente. La Postazione certificata e il
Raspberry non sono disponibili. Nessuna app e stata reinstallata o
re-enrollata e nessun dato applicativo e stato modificato.

B0-B3 formali non sono stati avviati. Lo state B4 resta integro a `2/10`; i
due dispositivi presenti sono gia registrati, mentre gli otto simulati non
contano. I file privati della raccolta B4 sono ora tutti `0600`, le directory
`0700` e i symlink assenti.

Alla ripresa: inventario `COMPLETE`, monitor Android/Raspberry avviati, login
controllato e reporter freschi; poi B0, B1, B2 `100/100` con p95 massimo
`8000 ms`, B3 per `3600 s` e infine otto nuove acquisizioni fisiche B4. B5 e
B6 restano chiusi.

Il runner richiede ora i ruoli `handheld` e `station` prima di poter emettere
`COMPLETE`. Il rerun con toolchain ADB esplicita vede i due Palmare, ma resta
`INCOMPLETE` per Postazione e Raspberry mancanti.

Verifica offline: stato `10/10`, inventario `16/16`, manifest `7/7`, consistenza
build `11/11`, B0 `12/12`, validatore pacchetto e manifest bidirezionale
`PASS`. Il dry-run B0 resta correttamente `PENDING_PHYSICAL_CAPTURE`.

Avanzamento ufficiale: **49%**.

## Rehearsal Web B5.7 Del 2026-08-10

Il banco Chrome isolato espone ora il comando `--pilot` e resta operativo con
otto Palmare web autenticati. Il rehearsal usa soltanto HTTP loopback: ha
raggiunto `ACTIVE`, completato `4/4` PING/PONG e un `CLOSE_ACK`, con zero
errori, cleanup completo e sessione browser preservata. Esito:
`NON_GATE_PASS`.

Il primo tentativo WebSocket e terminato `NON_GATE_FAIL` per timeout ed e
stato conservato privatamente senza sovrascrittura. Il PASS appartiene a un
run HTTP successivo e distinto. I test launcher/pilot chiudono `19/19 PASS`;
direct-control smoke, collector, supervisor e gate tecnico chiudono inoltre i
rispettivi self-test sintetici.

Il supervisor applica `umask 0077`; directory runtime `0700` e file privati
`0600`. Lo status pubblico espone soltanto integrita ledger ed esito redatto
del rehearsal. Nessun ADB, SSH, Bluetooth, GATT, Raspberry o UPS e stato
usato. Il ledger resta byte-identico a `2/10`, il pilot fisico resta
`PENDING`, la campagna B5 resta a `0/100` e B6 resta `BLOCKED`.

Runbook e rapporto pubblico:
`testing/B5_WEB_GUI_LOOPBACK_DIAGNOSTIC.md` e
`reports/V5BT_B5_WEB_GUI_LOOPBACK_DIAGNOSTIC_20260810.md` nel pacchetto
roadmap.

Avanzamento ufficiale: **49%**.

## Test Fisici Palmare E Raspberry Del 2026-08-17

Con due Palmare API 36 sulla build certificata `1.0.39/40`, il diagnostico B2
ravvicinato ha eseguito `100/100` cicli: `61` PASS, `39` timeout e p95
`14.064 ms`. Il pilot con quiescenza radio da almeno `31.000 ms` ha invece
chiuso `20/20 PASS`, zero timeout e p95 `6.737 ms`. Entrambe le evidenze sono
`NON_GATE_EVIDENCE`; B2 resta `PENDING`.

I due Palmare sono stati rilanciati e risultano autenticati, `READY`, distinti
e correttamente legati al registry. Il Raspberry e raggiungibile con servizi,
BlueZ e NTP conformi. Due monitor di continuita hanno raccolto rispettivamente
9 e 31 campioni stabili, poi sono terminati fail-closed su una lettura SSH:
nessuna attestazione PASS e stata prodotta.

La Postazione presente resta operativa ma non certificabile: Android API 31,
build `2.0.19/21` e firma non coincidente con la matrice. Serve una Postazione
API 33 o successiva prima di B0-B3 formali. Rapporto completo:
`DOCUMENTAZIONE/V5BT_TEST_FISICI_20260817.md`.

Avanzamento ufficiale: **49%**.

## Postazione API 31 Compat Del 2026-08-17

Sul tablet il package affiancato e stato aggiornato in-place con
`adb install -r` a `2.0.23-api31compat/25`. L'APK finale installato ha SHA-256
`c117dad07b1bbff88315770fccc4eba6d13d70ddb200300b901693e1ea636575`;
preferenze e identita sono rimaste byte-identiche e l'enrollment e `READY`.

Il fallback controller-unfiltered, limitato ad Android 12 non-gate, ha
confermato il difetto del filtro ServiceData Samsung. La cattura finale sullo
stesso APK ha prodotto `2.471` callback grezze, `9` UUID V5BT, `9` payload
validi e `36` finestre scan-advertise concorrenti, p95 `5.735 ms` e zero
errori scan o advertising. Wi-Fi durante BLE: `5/5` richieste HTTPS.
Background: `31,253 s` (`durationMs=31253`), `7/7` campioni stabili e gap
massimo `5,228 s` (`maxGapMs=5228`).

Una cattura sulla build immediatamente precedente, con sorgenti Bluetooth
identici, ha completato connessione, profilo e MTU `1/1/1` prima di
`HELLO_WRITE_FAILED` sullo stimulus profile-only. Il retest sull'APK finale ha
registrato `9` tentativi, `6` connessioni e `9` errori senza una sessione
stabile. Nel report finale `gattClientRuntime` e `FAIL` e
`gattServerRuntime` e `NOT_RUN`. Lo smoke GATT Raspberry e il cleanup sono
`PASS`; monitor
retry 5 `PASS` con `227` campioni in `464,501 s` (`durationMs=464501`), mentre
lo staging retry 4 ha raccolto `20` campioni in `33,660 s`
(`durationMs=33660`) senza fault.

Il fix batteria ancora la pianificazione al completamento della notifica
precedente. La misura finale ha osservato `3` notifiche in `270090 ms`, con
intervalli `120074 ms` e `121517 ms`: `batteryCadence PASS`. La partial
generica conserva cleartext OFF. Soltanto `api31Compat` consente HTTP locale,
derivato dal portale HTTPS, verso il servizio batteria `8865`; non viene
introdotto alcun fallback HTTP per frontend, API business o radio.

Report pubblici redatti:
`reports/physical/V5BT_API31_COMPAT_PHYSICAL_NON_GATE_20260817.md` nel pacchetto
roadmap e
`reports/physical/v5bt-api31-compat-physical-non-gate-20260817.json`. Il JSON
contiene `14` controlli `PASS`, `gattClientRuntime FAIL`,
`gattServerRuntime NOT_RUN` e verdetto `NON_GATE_FAIL`. Suite completa
`485/485 PASS`, runner report `17/17 PASS`. La variante non sostituisce una
Postazione certificata e non promuove B0-B5.

Avanzamento ufficiale: **49%**.

## Baseline Software Bluetooth B6-B11 Del 2026-08-18

La workspace contiene ora la baseline `SOFTWARE PASS OFFLINE / NON-GATE`,
senza blocker residui nel core transport/software coperto, per sessione
Android-Android A2, canale
affidabile DATA/ACK, durabilita schema `3`, route advertisement e command bus
shadow. Palmare e Postazione mantengono copie allineate dei componenti
Android; Raspberry e contratti condivisi restano nel pacchetto roadmap.

Confine operativo:

- tutti i flag Bluetooth normali restano OFF;
- `HEALTH/PING/TEST` sono i soli messaggi previsti in shadow;
- comande e ogni altro traffico business restano su `LAN_HTTP_SSE`;
- B9 Raspberry usa health loopback dinamico e advertiser BlueZ: il ServiceData
  v1 espone solo `serverReachable`, mentre route `LAN/NONE`, RTT e queue depth
  restano nel frame affidabile; il budget operativo e `<=4750 ms` e health
  stale chiude su `serverReachable=false`;
- batteria e UPS Raspberry restano `UNKNOWN`, senza probe o prova fisica;
- nessun routing multi-hop o fallback HTTP radio e autorizzato;
- una suite software PASS non promuove un gate fisico.

Lo storico B11 schema 1 resta `NON_GATE_PASS 4500/4500` su 10 nodi generici,
con digest
`2527641f52ad15459ede6debe628c9dd392b53e774ca39179c59dc95b3adb3a1`.
La baseline schema 2 usa 10 Palmari, 3 Postazioni, 1 Raspberry, 1 cassa
automatica e 1 RT, tutti virtualizzati. Chiude `NON_GATE_PASS 9100/9100`,
`2600/2600` azioni, 800 comande, `100/100` transazioni per periferica e zero
business BT; digest
`6b527f1003329004628dc79abad1db2d2ca607a68551f7030e699abda7ef8f37`.
Palmare debug e Postazione debug chiudono entrambi 59 classi e `340/340 PASS`,
zero failure, errori o skip. Il watchdog advertiser Postazione `api31Compat`
chiude `7/7 PASS` come test mirato e non costituisce una suite full della
variante. Prima di una build Lab fisica rieseguire comunque le suite e
aggiornare i conteggi se crescono.

Il massimo corrente e lo schema 3 `mixed-physical`: 2 Palmari fisici + 8
virtuali, 1 Postazione fisica + 2 virtuali, 1 Raspberry fisico, cassa e RT
virtuali. Il receipt e `MIXED_NON_GATE_INCOMPLETE`: sono osservati `2/4`
attori fisici, precisamente i due Palmari; Postazione e Raspberry risultano
`0/1`; radio, business fisico, monitor e soak sono
`NOT_RUN`. Nessun simulatore puo coprire uno dei quattro slot fisici.
Il contratto eseguibile schema 3 e `MIXED_NON_GATE_INCOMPLETE`-only: i criteri
4/4, 600+600, monitor e soak restano per una futura versione, non attivabile
senza manifest/receipt byte-bound, record per-link e per-actor, timestamp e
provenance live.
Nel v3 corrente `WAIVED_NON_GATE` e solo metadato per una policy futura e non
soddisfa readiness: l'inventario certifica l'APK con SHA-256 byte-esatto e
deriva la copertura signer dallo stesso binding, quindi signer ignorato
significa APK non certificato e `INCOMPLETE`. Non viene aggiunta una probe
signer separata.

L'assenza di accessi hardware descritta dal consolidamento precedente riguarda
lo schema 2. Stato autorevole invariato: B4
`2/10`, B5 `0/100`, B6 `PENDING/BLOCKED`, avanzamento **49%**. Riferimento:
`DOCUMENTAZIONE/V5BT_CHIUSURA_SOFTWARE_BLUETOOTH_20260818.md`.

Avanzamento ufficiale: **49%**.

## Consolidamento Corrente Del 2026-08-18

La dicitura di chiusura software va interpretata come chiusura del core
transport Bluetooth, non dell'intera roadmap. B7-B11 sono
`NON_GATE_PASS` software e restano `PENDING` fisico; B4 e B5 non cambiano e
il commitment B5 ora implementato non costituisce promozione.

Consolidamento tecnico:

- Raspberry/Node 24 `318/318 PASS`; `303/303` resta lo snapshot consolidato
  precedente e `292/292` quello della telemetria periodica, con metriche non
  osservabili pubblicate esplicitamente come `UNAVAILABLE`;
- B11 baseline schema 2 `17/17 PASS` mirati su runner+helper, 16 attori
  virtuali e zero accessi o attori fisici;
- B11 massimo schema 3 `MIXED_NON_GATE_INCOMPLETE`: 2/4 attori fisici
  osservati, cioe i due Palmari; Postazione e Raspberry 0/1, campagna
  fisica `NOT_RUN`; contratto corrente incomplete-only, B11 formale resta
  `PENDING`;
- Postazione `api31Compat` full offline `374/374 PASS`, lint e assemble
  `PASS`, fix API 24 incluso e configurazione `NON_INSTALLATA`;
- Palmare A2 `18/18 PASS`;
- badge diagnostico Bluetooth completato nei frontend Palmare e Postazione:
  feature flag, bridge/evento nativo, parser bounded fail-closed, cleanup,
  accessibilita, nessun identificatore e nessun claim business; verifiche
  Palmare `6/6`, Postazione `39/39`, typecheck/build e quattro viewport;
- P-010 avanzato per tranche: storage diretto eliminato nel perimetro,
  analytics separato in tipi/normalizzatori/builder puri e modelli estratti da
  prenotazioni, composer prodotto e dialogo di recovery, senza variazioni ai
  contratti applicativi;
- commitment account/device B5 implementato con digest canonico
  domain-separated redatto nello state schema `3`, nei `100` record,
  nell'attestazione Android `1.1`, nell'aggregate `1.5` e nel receipt `1.1`.
  La promotion `1.3` ricalcola ledger head e SHA-256 dei byte esatti delle due
  attestazioni e li confronta con aggregate e receipt; il legacy resta
  read-only e `PENDING`.

Le suite frontend funzionali P-010 chiudono `465/465` e `469/469`, con build
positivi. Il modulo `reservations.ts`, identico nelle due tree, e stato
estratto in `reservationModel.ts`: il facade scende da `1229` a `983` righe
logiche e i test mirati chiudono `21/21 PASS` per tree. Le estrazioni successive
della policy prodotto del composer e del modello recovery chiudono `6/6` e
`11/11 PASS` per tree. La rimozione di `38` priorita CSS ridondanti, verificata
su `84` varianti e due viewport senza differenze di stile o pixel, porta
`!important` da `305` al budget `267`. I test architecture chiudono quindi
`11/12 PASS` per tree: resta soltanto LOC, con quattro monoliti TSX in ciascuna
copia (`TablePaymentWizard`, `TablesWorkspace`, `PaymentSettlementSection`,
`AnalyticsWorkspace`).

Il commitment B5 chiude mirati `83/83 PASS` e Raspberry `303/303 PASS`. Non
ha usato hardware e non ha promosso B5 o altri gate.

Workload DOM immutabili del 18 agosto:

- primo `160/160`, `114` successi, `46` failure, conteggio HTTP `565`;
- secondo abort a `87/160`;
- terzo `130/160`, `113` successi, `17` failure, zero HTTP failure,
  `stopReason=PAGE_CLOSED`.

Esito aggregato `NON_GATE_FAIL`, senza ulteriori retry. Le correzioni chiudono
`75/75 PASS` e la suite aggiuntiva `55/55 PASS`; il residuo sotto carico resta
aperto. Nessuno di questi risultati promuove gate fisici.

Avanzamento ufficiale: **49%**.
