# B5 physical campaign runbook

## 1. Stato E Regole

Questo runbook descrive la futura campagna fisica B5. La sua governance e stata
preparata offline; la successiva ripresa del banco ha prodotto soltanto
inventario e diagnostica B0/B2, non un pilot o una sessione B5. Fixture,
self-test ed evidenza diagnostica non promuovibile non aumentano l'avanzamento
ufficiale, che resta **49%**.

La campagna ufficiale usa un solo Palmare Advanced `handheld`, con lo stesso
package, APK, utente Android, identita enrollata e account di test non
operativo per tutti i 100 record. Postazione Advanced riceve smoke separati
prima e dopo, ma non entra nel conteggio. Il pilot usa uno state diagnostico
distinto e non e promuovibile.

Il servizio `cassav5bt.service` non deve essere fermato, riavviato, ricaricato
o ridistribuito durante pilot e campagna. B5 resta `PENDING` anche dopo il
risultato tecnico; B6 resta chiusa fino alla promozione formale di B5.

## 2. Target Certificati

| Ruolo | Package | Versione | Code | SHA-256 Lab |
| --- | --- | --- | ---: | --- |
| Palmare | `com.sentrapa.palmare.advanced` | `1.0.39` | 40 | `d0af2fd9341d5e50b49a4cd68fe4e2a0f70f6d28ef7c0acc1361191b5afffa65` |
| Postazione | `com.sentrapa.postazione.advanced` | `2.0.23` | 25 | `3d55fa75e40e33134c8824b8c36a60d00622ea62528c67db3b74208fbcf868a5` |

Prima di usare il banco verificare offline, dalla root del workspace:

```bash
node scripts/verify-v5bt-advanced-build-consistency.mjs --root .
```

Il controllo confronta matrice certificata, Gradle, package, versione, code,
SHA-256 degli APK e parita dei sorgenti/test Bluetooth condivisi. Installare
poi soltanto con `adb install -r -g`: mai usare uninstall o `pm clear`.

L'APK Palmare atteso e
`artifacts/Palmare-Advanced-v1.0.39-V5BT-B0-B2-Cooldown-Lab-20260805-debug.apk`.
La baseline associata e Android `210/210`, lint `0` errori e `23` warning. La
regressione fisica di logout e `PASS / NON_GATE_EVIDENCE` e non sostituisce
alcun prerequisito B0-B4.

## 3. Autorizzazione B0-B4

La campagna ufficiale puo iniziare soltanto dopo evidenze fisiche valide:

1. B0: capability matrix, scan e advertise/peripheral secondo ruolo.
2. B1: protocollo, registry ed enrollment `READY`.
3. B2: due Android fissi, 100 discovery reciproche, p95 `<= 8000 ms`.
4. B3: due target fissi per esattamente `3600 s`, zero crash, ANR, restart o
   gap.
5. B4: dieci hardware distinti consecutivi e zero leak; il progresso `2/10`
   si conserva soltanto dopo rivalidazione di hash, identita, state e permessi.

Dopo il PASS B0-B3 e la rivalidazione integra del ledger B4 parziale e ammesso
un solo pilot diagnostico. Con B4 incompleto la campagna ufficiale resta
vietata.

Prima del primo tentativo creare un file privato `0600` conforme a
`contracts/b5-campaign-authorization-v1.schema.json`. Deve impegnare:

- lo SHA-256 del `campaignRunId`, senza esportare l'UUID;
- lo SHA-256 della matrice certificata;
- il bundle di evidenze B0-B4;
- un commitment nonzero dell'operatore;
- B0, B1, B2, B3 e B4 tutti `PASS`;
- stesso Palmare, build e account, monitor Android/Raspberry continui,
  servizio principale continuo e review indipendente obbligatoria.

L'autorizzazione lascia `b5HundredSessionGate: PENDING` e `b6: PENDING`.

Stato prerequisiti al 2026-08-04: il B2 diagnostico schema 5 su due Palmare ha
completato `100/100` cicli con 95 pass, 5 timeout e p95 19.145 ms. La soglia
richiesta e 8.000 ms e manca la Postazione certificata; B0 e B2 formali restano
`PENDING`, B3 non e stato avviato e B4 non e completo. Di conseguenza questo
runbook non autorizza ancora ne il pilot B5.7 ne la campagna ufficiale.
Il B0 supplementare registra PASS per scan, advertising, concorrenza,
coesistenza Wi-Fi/BLE e foreground/background su entrambi i Palmare, ma client
e server GATT restano `FAIL/NOT_PROVEN`. L'attestazione Raspberry separata ha
chiuso PASS su 5.541 campioni; questi dati non sostituiscono i prerequisiti
formali mancanti.

Dal 2026-08-05 tutte queste acquisizioni sono evidenze storiche perche
ottenute con Palmare `1.0.36`. Non possono essere usate nell'autorizzazione
B0-B4 della nuova build: inventario, verifica del target, monitor e prove
fisiche applicabili devono essere ripetuti con `1.0.39` code `40`. B0-B5
restano `PENDING`; pilot e campagna ufficiale non sono ancora autorizzati.

Stato al 2026-08-06: il ledger B4 corrente contiene `2/10` hardware fisici
distinti. Eventuali slot sintetici sono esclusivamente `NON_GATE_EVIDENCE`,
contano zero nel ledger e non sostituiscono B0-B3 formali. Il pilot resta
vietato finche la coppia Palmare/Postazione non chiude B0-B3 `PASS`.

## 4. Inventario Read-Only

Dalla root del workspace eseguire, prima di qualsiasi mutazione:

```bash
node scripts/run-v5bt-bench-inventory.mjs \
  --raspberry-host "$RASPBERRY_HOST" \
  --android palmare,handheld,"$HANDHELD_SERIAL","$ANDROID_USER" \
  --android postazione,station,"$STATION_SERIAL","$STATION_USER" \
  --private-output "$PRIVATE/bench-inventory-private.json" \
  --summary-output "$PRIVATE/bench-inventory-redacted.json"
```

L'inventario usa una allowlist fissa di sole letture e correla ADB, package,
versioni, APK, user, permessi, sessioni, enrollment, Raspberry, BlueZ, NTP,
servizi, registry e permessi privati. L'UPS viene **solo rilevato** tramite
discovery e unita di servizio: non legge dati proprietari e non inventa un
driver o un protocollo prima dell'ispezione dell'hardware reale.

Conservare il report completo privatamente; usare fuori dal banco soltanto il
riepilogo redatto. Un inventario `INCOMPLETE` blocca la prova.

## 5. Pilot Diagnostico

Il pilot usa state e ledger con suffisso `diagnostic`, snapshot privati prima
e dopo e non entra nella campagna ufficiale. Eseguire prima lo smoke separato
Postazione, poi:

```bash
node raspberry/scripts/collect-b5-direct-control-session.mjs \
  --init --state "$PRIVATE/b5-diagnostic-state.json"
node raspberry/scripts/run-b5-campaign-supervisor.mjs \
  --init --ledger "$PRIVATE/b5-diagnostic-attempts.json" \
  --state "$PRIVATE/b5-diagnostic-state.json"
node raspberry/scripts/run-b5-campaign-supervisor.mjs \
  --preflight --ledger "$PRIVATE/b5-diagnostic-attempts.json" \
  --state "$PRIVATE/b5-diagnostic-state.json"
node raspberry/scripts/run-b5-campaign-supervisor.mjs \
  --capture --ledger "$PRIVATE/b5-diagnostic-attempts.json" \
  --state "$PRIVATE/b5-diagnostic-state.json"
node raspberry/scripts/run-b5-campaign-supervisor.mjs \
  --status --ledger "$PRIVATE/b5-diagnostic-attempts.json" \
  --state "$PRIVATE/b5-diagnostic-state.json"
```

Il pilot deve raggiungere `ACTIVE`, completare quattro PING/PONG totali,
`CLOSE/CLOSE_ACK`, zero errori e cleanup completo. Lo state resta `1/100` e
non viene finalizzato, importato o riutilizzato.

### Rehearsal Web Separato

Il comando `--pilot` del banco Chrome esegue soltanto il rehearsal
`B5_7_WEB_GUI_LOOPBACK_DIAGNOSTIC` su HTTP loopback. Non usa Bluetooth o GATT,
non crea collector, ledger tentativi o autorizzazioni e registra zero sessioni
ufficiali. Anche con esito `NON_GATE_PASS` non soddisfa questa sezione, non
autorizza il pilot fisico e lascia B4 e B5 `PENDING`. Il contratto separato e
in `testing/B5_WEB_GUI_LOOPBACK_DIAGNOSTIC.md`.

## 6. Inizializzazione Ufficiale

Ordine obbligatorio:

1. inizializzare un nuovo collector state schema v2;
2. inizializzare il ledger supervisor schema v1 sullo stesso
   `campaignRunId`;
3. creare l'autorizzazione B0-B4 prima del primo tentativo;
4. creare le config Android e Raspberry sullo stesso UUID privato;
5. eseguire il preflight supervisor non mutante;
6. acquisire entrambe le baseline;
7. avviare entrambi i monitor in shell separate;
8. eseguire gli slot `001..100` soltanto tramite il supervisor;
9. finalizzare il collector e attendere il termine naturale dei monitor;
10. generare nella stessa directory privata la coppia immutabile aggregato
    tecnico/receipt;
11. sottoporre aggregato e receipt a review indipendente e promozione.

```bash
node raspberry/scripts/collect-b5-direct-control-session.mjs \
  --init --state "$PRIVATE/b5-official-state.json"
node raspberry/scripts/run-b5-campaign-supervisor.mjs \
  --init --ledger "$PRIVATE/b5-official-attempts.json" \
  --state "$PRIVATE/b5-official-state.json"
node raspberry/scripts/run-b5-campaign-supervisor.mjs \
  --preflight --ledger "$PRIVATE/b5-official-attempts.json" \
  --state "$PRIVATE/b5-official-state.json"
```

Directory private `0700`; state, ledger, config, baseline, monitor output,
autorizzazioni, aggregate, receipt e review `0600`; ogni output deve essere
nuovo, a link singolo e fuori dal repository.

## 7. Monitor Android E Raspberry

La config Android conserva i campi `expected` gia previsti; la config
Raspberry ha forma esatta:

```json
{
  "schemaVersion": 1,
  "product": "V5BT",
  "phase": "B5",
  "campaignId": "<campaignRunId privato>",
  "measurement": { "durationMs": 7200000 }
}
```

`durationMs` deve coprire tutta la raccolta e la finalizzazione, tra
`6000000` e `14400000`. L'esempio usa due ore per lasciare margine oltre i
100 slot; dimensionare entrambe le config sulla durata reale attesa senza
scendere sotto l'intera campagna. Acquisire le baseline prima del primo
tentativo:

```bash
node scripts/run-b5-android-continuity-monitor.mjs \
  --capture-baseline --adb /percorso/assoluto/adb \
  --serial "$HANDHELD_SERIAL" --package com.sentrapa.palmare.advanced \
  --role handheld --config "$PRIVATE/b5-android-monitor-config.json" \
  --baseline "$PRIVATE/b5-android-monitor-baseline.json"

node scripts/run-b5-raspberry-continuity-monitor.mjs \
  --capture-baseline --systemctl /usr/bin/systemctl \
  --boot-id-file /proc/sys/kernel/random/boot_id \
  --config "$PRIVATE/b5-raspberry-monitor-config.json" \
  --baseline "$PRIVATE/b5-raspberry-monitor-baseline.json"
```

Avviare poi entrambi i monitor in shell dedicate:

```bash
node scripts/run-b5-android-continuity-monitor.mjs \
  --monitor --adb /percorso/assoluto/adb \
  --serial "$HANDHELD_SERIAL" --package com.sentrapa.palmare.advanced \
  --role handheld --config "$PRIVATE/b5-android-monitor-config.json" \
  --baseline "$PRIVATE/b5-android-monitor-baseline.json" \
  --private-output "$PRIVATE/b5-android-monitor-private.json" \
  --attestation "$PRIVATE/b5-android-attestation.json" --poll-ms 1000

node scripts/run-b5-raspberry-continuity-monitor.mjs \
  --monitor --systemctl /usr/bin/systemctl \
  --boot-id-file /proc/sys/kernel/random/boot_id \
  --config "$PRIVATE/b5-raspberry-monitor-config.json" \
  --baseline "$PRIVATE/b5-raspberry-monitor-baseline.json" \
  --private-output "$PRIVATE/b5-raspberry-monitor-private.json" \
  --attestation "$PRIVATE/b5-raspberry-attestation.json" --poll-ms 1000
```

Il monitor Raspberry controlla in continuita `cassav5bt.service` e
`bluetooth.service`: boot ID, clock, `MainPID`, `NRestarts`,
`ActiveEnterTimestampMonotonic` ed `ExecMainStartTimestampMonotonic`. La sua
attestazione esportabile e legata alla campagna ma non contiene hostname,
PID, percorsi o identificatori.

Entrambi i monitor pubblicano risultato privato e attestazione come una coppia
recuperabile. Il journal si trova in
`<private-output>.publication-v1.journal.json`, e privato `0600` e lega
campagna, path, documenti e SHA-256. Se il processo cade durante la
pubblicazione, rieseguire lo stesso comando `--monitor` con gli stessi path:
il journal completa e rivalida la coppia prima di qualunque nuovo polling. Un
artefatto gia presente senza journal, un digest diverso o un tentativo di
overwrite falliscono chiusi.

Il calendario di entrambi i monitor usa `ceil(duration/poll)+1` campioni e
clampa l'ultima scadenza alla durata richiesta, quindi copre anche durate non
divisibili per `poll-ms`. Non interrompere i monitor. Devono iniziare prima del
primo tentativo, includere timeout e riprese, terminare dopo l'ultimo tentativo
e produrre PASS naturalmente. Il gate confronta la copertura con
`attemptLedger.coverageFromMs..coverageUntilMs`, non soltanto con i cento
commit. Gap di polling, reboot, clock regressivo o cambi di processo/servizio
invalidano la campagna. L'attestazione Android accettata dal gate deve avere
ruolo esatto `handheld`.

## 8. Supervisor E Retry

Il ledger tentativi schema v1 e separato dallo state collector v2. Ha lo
stesso `campaignRunId`, una hash-chain e recovery atomico; rifiuta symlink,
hardlink, permessi diversi da `0600`, manomissioni e sovrascritture.

Per ogni slot usare esclusivamente:

```bash
node raspberry/scripts/run-b5-campaign-supervisor.mjs \
  --capture --ledger "$PRIVATE/b5-official-attempts.json" \
  --state "$PRIVATE/b5-official-state.json"
node raspberry/scripts/run-b5-campaign-supervisor.mjs \
  --status --ledger "$PRIVATE/b5-official-attempts.json" \
  --state "$PRIVATE/b5-official-state.json"
```

Solo `DIRECT_CONTROL_ORCHESTRATION_TIMEOUT`, con cleanup verificato e count
collector invariato, produce `RADIO_TIMEOUT` e ritenta lo stesso slot. Un
successo produce `COMMITTED` e azzera i timeout consecutivi. Tre timeout
consecutivi producono `SUSPENDED`; la sola ripresa ammessa e:

```bash
node raspberry/scripts/run-b5-campaign-supervisor.mjs \
  --resume --ledger "$PRIVATE/b5-official-attempts.json" \
  --state "$PRIVATE/b5-official-state.json"
```

La ripresa deve restare dentro le stesse finestre dei monitor e senza nuove
baseline. Ogni altro errore, incluso cleanup incompleto o clock regressivo,
produce `INVALIDATED`. In particolare, una regressione del clock rilevata
durante `--resume` invalida il ledger senza riattivarlo. Un journal supervisor
incompleto richiede `--resume`, che esegue la recovery prima di consentire
altri tentativi; non confonderlo con i journal di pubblicazione dei monitor.

## 9. Stop E Invalidazione

Invalidano immediatamente crash, ANR, reason 10, logout, force-stop, ADB gap,
PID/reporter/user/package/APK/account change, reboot, clock regressivo,
restart o transizione dei servizi, incremento `NRestarts`, gap Raspberry,
overlap, tamper, conflitto recovery, cambio target o cleanup incompleto.

Archiviare state, ledger, journal, coppie monitor e receipt privati senza
editarli. La nuova campagna riparte da `001` con nuovi state, ledger, baseline,
autorizzazione, attestazioni, aggregato e receipt.

## 10. Finalizzazione E Gate Tecnico

A `100/100` il ledger deve essere `COMPLETE` e il collector viene finalizzato:

```bash
node raspberry/scripts/collect-b5-direct-control-session.mjs \
  --finalize --state "$PRIVATE/b5-official-state.json" \
  --manifest "$PRIVATE/b5-hundred-session-manifest.json"

node raspberry/scripts/run-b5-hundred-session-gate.mjs \
  --manifest "$PRIVATE/b5-hundred-session-manifest.json" \
  --campaign-state "$PRIVATE/b5-official-state.json" \
  --attempt-state "$PRIVATE/b5-official-attempts.json" \
  --android-attestation "$PRIVATE/b5-android-attestation.json" \
  --raspberry-attestation "$PRIVATE/b5-raspberry-attestation.json" \
  --campaign-authorization "$PRIVATE/b5-campaign-authorization.json" \
  --output "$PRIVATE/b5-technical-aggregate.json" \
  --technical-receipt "$PRIVATE/b5-technical-receipt.json"
```

Il gate richiede 100 report fisici unici e ordinati, state collector, ledger
tentativi, autorizzazione B0-B4 e attestazioni Android/Raspberry della stessa
campagna. L'autorizzazione deve essere stata emessa non oltre
`coverageFromMs`, prima del primo tentativo. Entrambe le attestazioni devono
coprire l'intervallo completo `coverageFromMs..coverageUntilMs`, inclusi
timeout e riprese, e Android deve attestare il Palmare `handheld`.

`--output` e `--technical-receipt` sono obbligatori, distinti e nella stessa
directory privata. Il gate prepara entrambi, li pubblica come coppia
immutabile e fa rollback se non puo completare la coppia; non sovrascrive mai
un artefatto esistente. Il receipt schema v1 e definito da
`contracts/b5-technical-receipt-v1.schema.json` e costruito tramite
`scripts/b5-technical-receipt.mjs`. Lega:

- SHA-256 dei byte esatti di aggregato, collector state, autorizzazione,
  matrice certificata e due attestazioni;
- commitment di campagna e raccolta;
- testa della hash-chain del ledger tentativi;
- bundle prerequisiti B0-B4 e commitment operatore.

L'esito positivo e solo:

```text
verdict: TECHNICAL_PASS
b5TechnicalGate: PASS
b5HundredSessionGate: PENDING_REVIEW
b6: PENDING
```

Quindi B5 resta ufficialmente `PENDING`.

## 11. Review E Promozione

Calcolare lo SHA-256 dei byte esatti dell'aggregato tecnico. Non modificare ne
l'aggregato ne il receipt dopo la pubblicazione. Un revisore
diverso dall'operatore crea un file `0600` conforme a
`contracts/b5-review-attestation-v1.schema.json`, legato a quell'hash, allo
stesso bundle B0-B4 e al commitment dell'operatore. I commitment di operatore
e revisore devono essere distinti e la review deve essere successiva
all'aggregato tecnico.

La review deve attestare PASS per integrita evidenze, autorizzazione B0-B4,
policy tentativi, continuita Android/Raspberry, cleanup/ripristino e privacy.
Poi eseguire:

```bash
node raspberry/scripts/run-b5-promotion-gate.mjs \
  --technical-aggregate "$PRIVATE/b5-technical-aggregate.json" \
  --technical-receipt "$PRIVATE/b5-technical-receipt.json" \
  --campaign-state "$PRIVATE/b5-official-state.json" \
  --campaign-authorization "$PRIVATE/b5-campaign-authorization.json" \
  --review-attestation "$PRIVATE/b5-independent-review.json" \
  --output "$PRIVATE/b5-promotion.json"
```

Il parser dell'aggregato e esatto: campi mancanti, extra, annidati incompleti o
valori non canonici vengono rifiutati. Il promotion gate verifica il receipt
contro i byte ricevuti e contro state, autorizzazione, matrice, campagna,
raccolta, testa del ledger, prerequisiti, operatore e attestazioni impegnate.
Assenza o mismatch di aggregate, receipt o sign-off, oppure review non
indipendente, lasciano B5 `PENDING`. Solo il report di promozione valido puo
produrre `b5HundredSessionGate: PASS`. Anche dopo questa promozione B6 resta
`PENDING` finche non viene avviata come fase separata.

## 12. Ripristino

Build normali:

```text
Palmare:    a1f10e89f0d91be57fe240b9f6295f7c28895448bda14952fd5bc0e5630d5b30
Postazione: be297b3223fcbff45ff68245ab049a8c37fc83943376dd4a610d8cd82cc18769
```

Reinstallare con `adb install -r -g`. Verificare dati ed enrollment presenti,
reporter Lab assente, zero runner/advertiser/lock, adapter allo stato iniziale
e health del servizio principale invariata. Eseguire lo smoke Postazione
separato. B6 puo iniziare soltanto dopo il report di promozione B5 valido.
