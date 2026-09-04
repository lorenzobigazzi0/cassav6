# B4.4 Ten-Device Physical Gate

## Scope

Questo gate chiude B4 soltanto dopo dieci acquisizioni B4.3 eseguite una
dopo l'altra con dieci dispositivi Android fisici distinti:

```text
10 report B4.3 + 10 log B4.3 + 20 attestazioni monitor
-> rivalidazione integrale di ogni log
-> continuita Android e Raspberry per l'intera finestra
-> correlazione privata alias / registry B1
-> controllo di unicita e sequenzialita
-> report B4.4 redatto
```

Il gate non apre GATT, non avvia B5 e non modifica backend, database o
business logic POS.

## Raccolta progressiva su workstation

Il collector:

```text
scripts/collect-b4-physical-device.mjs
```

acquisisce i dieci dispositivi in sessioni successive senza confondere alias
ruotati con hardware diversi. Non e una seconda fonte del verdetto: anche a
`10/10` mantiene `b4TenDeviceGate=PENDING` e prepara soltanto il manifest per
il runner Raspberry autorevole.

Inizializzazione in una directory privata esterna al repository:

```powershell
node scripts/collect-b4-physical-device.mjs `
  --init `
  --state D:\cassav2\.v6-private\b4-device-gate-state.json
```

L'inizializzazione crea esclusivamente uno state privato schema v2 vuoto,
`0/10`. Lo state congela il binding canonico completo della matrice certificata:
schema e algoritmo di canonicalizzazione, SHA-256 della matrice, package, versioni,
codici build, SHA-256 degli APK, SHA-256 dei certificati di firma e percorsi degli
artefatti per Palmare e Postazione. Il collector ricalcola e confronta questo
binding prima e dopo ogni operazione.

Uno state schema v1 viene rifiutato: non e prevista migrazione e il risultato
storico `1/10` non deve essere ricostruito. Un cambio o una manomissione della
matrice interrompe la raccolta prima di ADB e prima della lettura delle evidenze
Raspberry; un cambio durante l'operazione impedisce staging e commit dello slot.

Prima di spendere i 90 secondi del runner Raspberry, vincolare esplicitamente
il preflight al device da acquisire e verificare che sia pronto e non sia gia
presente nel ledger. Altri device ADB possono restare collegati, ma non vengono
letti dal collector:

```powershell
node scripts/collect-b4-physical-device.mjs `
  --preflight `
  --state D:\cassav2\.v6-private\b4-device-gate-state.json `
  --adb C:\path\to\adb.exe `
  --serial SERIAL_ADB_TARGET `
  --package com.sentrapa.palmare.advanced
```

Il preflight restituisce `PASS / READY_FOR_CAPTURE` soltanto per un hardware
nuovo. Per un device gia registrato restituisce exit code `2` e
`NOT_ELIGIBLE / ALREADY_RECORDED`. Non legge evidenze Raspberry, non crea slot,
non modifica il ledger, non crea lock e non puo promuovere B4. Verifica inoltre
che il binding congelato nello state corrisponda ancora alla matrice certificata
corrente; lo state viene ricontrollato byte per byte dopo il preflight.

Dopo il preflight, generare un `captureRunId` UUID v4 nuovo e avviare entrambi
i monitor prima del runner B4.3. Il monitor Android ricava `collectionRunId`,
matrice certificata e chiave di commitment esclusivamente dallo state privato;
package e ruolo Palmare sono fissi nel codice:

```powershell
node scripts/run-v6-b4-android-continuity-monitor.mjs `
  --adb C:\path\to\adb.exe `
  --serial SERIAL_ADB_TARGET `
  --android-user-id 0 `
  --capture-run-id UUID_CAPTURE `
  --collector-state D:\cassav2\.v6-private\b4-device-gate-state.json `
  --private-output D:\private\android-monitor.jsonl `
  --attestation D:\private\android-attestation.json `
  --duration-seconds 120
```

Il monitor Raspberry usa gli stessi `collectionRunId`, `captureRunId` e
SHA-256 della matrice letti privatamente dallo state. Deve partire prima del
runner, osservarne l'intero ciclo e terminare soltanto dopo il cleanup radio:

```powershell
node scripts/run-v6-b4-raspberry-continuity-monitor.mjs `
  --host RASPBERRY_TEST `
  --user admin `
  --collection-run-id UUID_COLLECTION `
  --capture-run-id UUID_CAPTURE `
  --certification-matrix-sha256 SHA256_MATRIX `
  --private-output D:\private\raspberry-monitor.jsonl `
  --attestation D:\private\raspberry-attestation.json `
  --stop-file D:\private\b4-stop `
  --maximum-seconds 180
```

Eseguire il runner fisico B4.3 da 90 secondi mentre entrambi i monitor sono
attivi, verificare il cleanup e poi creare il file stop `0600`. Quando i due
monitor hanno prodotto attestazioni `PASS`, registrare lo slot soltanto tramite
il wrapper monitorato:

```powershell
node scripts/run-b4-monitored-slot-gate.mjs `
  --record `
  --state D:\cassav2\.v6-private\b4-device-gate-state.json `
  --capture-run-id UUID_CAPTURE `
  --android-monitor-attestation D:\private\android-attestation.json `
  --raspberry-monitor-attestation D:\private\raspberry-attestation.json `
  --adb C:\path\to\adb.exe `
  --serial SERIAL_ADB_TARGET `
  --package com.sentrapa.palmare.advanced `
  --raspberry-report D:\private\capture.json `
  --raspberry-log D:\private\capture.log
```

Gli slot monitorati B4 accettano esclusivamente il Palmare certificato.
`--serial` e obbligatorio sia in preflight sia in record; il collector rifiuta
cambi di target, utente Android, package, build o identita hardware durante
l'acquisizione.
Esegue il preflight Android canonico, legge lo stato radio Lab privato,
correla temporalmente Android e Raspberry e deriva un digest HMAC dal seriale
hardware. Seriale, digest e chiave HMAC non entrano nei report.

Il wrapper e il collector rivalidano entrambi le attestazioni con i parser
canonici prima di ADB, richiedono gli stessi commitment di collection, capture
e matrice, e verificano che la finestra Android/Raspberry copra runner e cleanup.
Il collector ricomputa inoltre il commitment HMAC dell'hardware dal seriale ADB:
chiamare direttamente il collector non consente di aggirare questi controlli.

Ogni coppia validata viene copiata accanto allo stato in una directory
owner-only `.evidence`. Scrittura di stato, lock e staging sono riprendibili:
lo stesso device con la stessa evidenza e idempotente; un device gia usato con
evidenza diversa o un report/log riutilizzato vengono rifiutati.

Stato della raccolta:

```powershell
node scripts/collect-b4-physical-device.mjs `
  --status `
  --state D:\cassav2\.v6-private\b4-device-gate-state.json
```

A `10/10`, generazione del manifest privato:

```powershell
node scripts/collect-b4-physical-device.mjs `
  --finalize `
  --state D:\cassav2\.v6-private\b4-device-gate-state.json `
  --manifest D:\cassav2\.v6-private\b4-manifest.json
```

Il comando crea anche `collector-final.json`. Manifest, collector report e
directory `.evidence` devono essere trasferiti insieme sul Raspberry,
conservati con directory `0700` e file `0600`, quindi passati al runner
autorevole descritto sotto. Lo stato con chiave HMAC resta privato sulla
workstation. La correlazione ADB/HMAC e un controllo aggiuntivo di raccolta;
l'unicita finale resta quella del registry B1.

## Fonte autorevole delle identita

Gli alias BLE ruotano e non rappresentano identita stabili. Il runner usa
`DeviceRegistryV1` come unica fonte privata e deriva gli alias attesi tramite
`deriveRotatingAliasForNode(...)`. La chiave alias non viene letta o esportata
direttamente.

Ogni acquisizione deve:

- corrispondere a un solo device attivo e non revocato;
- non contenere alias riconducibili a device diversi;
- risolvere a un NodeId diverso dagli altri nove slot.

NodeId, alias, MAC, bootId, seriali, percorsi e payload non entrano nel report
finale.

## Evidenze private

Preparare una directory owner-only sul Raspberry:

```bash
install -d -m 700 /var/lib/cassav6-bluetooth/b4-evidence
```

Ogni coppia report/log e ogni attestazione devono provenire dallo stesso run
fisico B4.3 completo e avere permessi `0600`. Il manifest privato schema v2
lega ogni slot alle due attestazioni e ai relativi SHA-256. La forma di ogni
elemento `captures` e esatta:

```json
{
  "schemaVersion": 2,
  "gate": "B4_TEN_PHYSICAL_DEVICES",
  "collectionRunId": "UUID_COLLECTION",
  "certificationMatrixSha256": "SHA256_MATRIX",
  "collectorReport": "collector-final.json",
  "captures": [
    {
      "slot": 1,
      "captureRunId": "UUID_CAPTURE_01",
      "report": "b4-state.json.evidence/capture-01.json",
      "log": "b4-state.json.evidence/capture-01.log",
      "androidMonitor": "b4-state.json.evidence/capture-01.android-monitor.json",
      "androidMonitorSha256": "SHA256_ANDROID_ATTESTATION_01",
      "raspberryMonitor": "b4-state.json.evidence/capture-01.raspberry-monitor.json",
      "raspberryMonitorSha256": "SHA256_RASPBERRY_ATTESTATION_01"
    }
  ]
}
```

Lo stesso record deve essere presente per gli slot ordinati `1..10`, con UUID,
percorsi e hash distinti.

Sono ammessi soltanto percorsi relativi portabili sotto la directory del
manifest. Path traversal, symlink su Linux, file non regolari, duplicati,
campi extra e permessi diversi da `0600` causano `FAIL`.

## Comandi

Dal Raspberry, nella directory `raspberry`:

```bash
npm run check
npm test
npm run gate:b4-ten-device -- --self-test
npm run gate:b4-ten-device -- \
  --manifest /var/lib/cassav6-bluetooth/b4-evidence/manifest.json \
  --registry /var/lib/cassav6-bluetooth/devices.json \
  --output ../reports/physical/v6-b4-4-ten-device-gate.json
```

Il self-test usa dati sintetici, non accede al registry e non promuove B4.

Comandi locali del collector, senza radio:

```bash
node --test scripts/collect-b4-physical-device.test.mjs
node --test scripts/run-b4-monitored-slot-gate.test.mjs
node scripts/collect-b4-physical-device.mjs --self-test
```

## Simulazione ibrida non-gate

Quando sono disponibili soltanto due hardware distinti, il runner seguente
puo completare in RAM gli slot logici `3..10` per collaudare ordinamento,
unicita, hash-chain e redazione del flusso a dieci elementi:

```bash
node scripts/run-b4-offline-hybrid-non-gate.mjs \
  --run \
  --state /percorso/privato/physical/b4-device-gate-state.json \
  --output /percorso/privato/non-gate/b4-hybrid-non-gate.json
```

Il runner richiede esattamente `2` record fisici gia validi nello state ed
esattamente `8` record simulati. Legge lo state in sola lettura, crea gli
elementi sintetici soltanto in memoria e verifica che lo state resti identico
byte per byte. Mantiene per l'intera operazione lo stesso lock privato usato
dal collector, impedendo una raccolta concorrente supportata.

La directory di output deve essere separata dalla directory dello state,
esterna al pacchetto roadmap e `0700`. Il report e `NON_GATE_EVIDENCE`, viene
scritto `0600` senza sovrascrittura, con pubblicazione atomica, `fsync` della
directory e rollback verificato. Uno schema allowlist esatto impedisce di
pubblicare gate alterati, campi extra, identificatori, percorsi, hash o
timestamp fisici.

Questa modalita non esegue il gate autorevole, non crea manifest, non modifica
evidenze e conta `0` dispositivi simulati verso B4. Il risultato ammesso e
soltanto `NON_GATE_PASS` con B4 e B5 `PENDING`, B6 `BLOCKED` e pilot B5.7 non
autorizzato. Gli otto slot devono comunque essere sostituiti, uno alla volta,
da otto hardware Android distinti prima di poter finalizzare B4.

Verifica locale:

```bash
node --test scripts/run-b4-offline-hybrid-non-gate.test.mjs
node scripts/run-b4-offline-hybrid-non-gate.mjs --self-test
```

## Banco grafico Chrome non-gate

Gli otto slot sintetici possono essere materializzati anche come otto Palmare
web grafici, ognuno in un contesto Chrome, pagina, account, storage e sessione
distinti. Il banco usa frontend e backend isolati su loopback e mantiene il
ledger fisico in sola lettura, controllandone il fingerprint per tutta la vita
del supervisore.

Questa variante chiude la copertura GUI simulata `10/10`, ma mantiene
`simulatedDevicesCountedTowardGate: 0`. Produce esclusivamente
`NON_GATE_EVIDENCE`, non accede alle evidenze fisiche e non puo cambiare B4,
B5 o B6. Contratto e comandi sono documentati in
`testing/B4_EIGHT_CHROME_GUI_NON_GATE.md`.

## Criteri PASS

- esattamente 10 slot ordinati da 1 a 10;
- collector report `MANIFEST_READY` con 10 hardware distinti e gate ancora
  `PENDING`;
- corrispondenza esatta dei 10 hash report/log fra collector e verifier;
- 10 coppie di attestazioni Android/Raspberry `PASS`, canoniche, con hash
  corrispondenti al manifest e commitment collection/capture/matrice coerenti;
- copertura continua del runner e del cleanup, senza crash, ANR, logout,
  riavvii di processo/reporter, reboot o restart dei servizi;
- 10 report B4.3 `PASS`, ognuno legato al proprio log tramite SHA-256;
- rivalidazione B4.3 del log senza fidarsi del report salvato;
- almeno 90 secondi a parete e 75 secondi di lifecycle per acquisizione;
- callback ServiceData, expiry, pruning e cleanup validi per ogni slot;
- finestre temporali non sovrapposte e ordinate;
- hash di report e log non riutilizzati;
- 10 identita B1 attive, autorizzate e distinte;
- report finale senza dati identificativi o percorsi privati.

Solo il risultato fisico che soddisfa tutti questi criteri puo impostare:

```text
gate.b4 = PASS
gate.b5 = PENDING
```

Con meno di dieci device reali B4 resta `PENDING`.
