# B5 physical campaign checklist

Questa checklist non promuove alcun gate. Le catture fisiche del 4 agosto
restano storiche perche appartengono alla precedente build Palmare `1.0.36`.
Devono essere ripetute con il target corrente; l'avanzamento ufficiale resta
**49%**.

## Prerequisiti B0-B4

- [ ] B0: capability matrix verificata; scan e advertise/peripheral secondo
      ruolo.
- [ ] B1: protocollo valido; enrollment e registry `READY` per i target.
- [ ] B2: 100 discovery reciproche tra due Android fissi, p95 `<= 8000 ms`.
- [ ] B3: foreground service osservato per esattamente `3600 s`, senza crash,
      ANR, restart o gap.
- [ ] B4: dieci hardware distinti consecutivi, registry correlato e zero leak.
- [ ] Tutte le evidenze fisiche B0-B4 usate nell'autorizzazione sono state
      acquisite con Palmare `1.0.39` code `40` e Postazione `2.0.23` code
      `25`; nessuna cattura di build precedente e stata riutilizzata.
- [ ] Il ledger B4 `2/10` e conservato solo dopo verifica di hash, identita,
      stato, permessi e assenza di tamper.
- [ ] Il pilot e ammesso solo dopo PASS B0-B3 e rivalidazione del ledger B4
      parziale; non sostituisce B4.
- [ ] Nessuna campagna ufficiale viene inizializzata prima del PASS B0-B4.

## Verifiche Offline

- [ ] `verify-v5bt-advanced-build-consistency.mjs` restituisce `ok: true`.
- [ ] Matrice, Gradle, package, versioni, code e SHA-256 coincidono.
- [ ] I sorgenti e i test Bluetooth condivisi tra Palmare e Postazione sono
      pari, salvo differenze esplicitamente ammesse dal verificatore.
- [ ] APK Lab conformi: Palmare `1.0.39` code `40` e Postazione `2.0.23` code
      `25`.
- [ ] Palmare Lab artefatto
      `artifacts/Palmare-Advanced-v1.0.39-V5BT-B0-B2-Cooldown-Lab-20260805-debug.apk`,
      SHA-256
      `d0af2fd9341d5e50b49a4cd68fe4e2a0f70f6d28ef7c0acc1361191b5afffa65`.
- [ ] Postazione Lab artefatto
      `artifacts/Postazione-Advanced-v2.0.23-V5BT-B0-B2-Cooldown-Lab-20260805-debug.apk`,
      SHA-256
      `3d55fa75e40e33134c8824b8c36a60d00622ea62528c67db3b74208fbcf868a5`.
- [ ] Il verificatore di consistenza conferma matrice, sorgenti condivisi e
      build correnti prima di ogni acquisizione fisica.

## Inventario Del Banco

- [ ] L'inventario unico read-only termina `COMPLETE` e usa soltanto la
      command allowlist prevista.
- [ ] La copertura ruoli richiede almeno un Palmare `handheld` e una Postazione
      `station`; soli Palmare devono terminare `INCOMPLETE`.
- [ ] ADB, Android user, package, versioni, APK e permessi sono corretti.
- [ ] Sessioni, identita enrollate, registry e relativi binding sono coerenti.
- [ ] Raspberry, BlueZ, NTP e servizi richiesti sono disponibili e stabili.
- [ ] Directory e file privati di registry, enrollment, TLS e config hanno
      owner e permessi attesi.
- [ ] UPS rilevato esclusivamente in modalita discovery; nessun driver o
      protocollo proprietario e assunto prima dell'ispezione fisica.
- [ ] Report completo conservato privatamente; riepilogo esportabile redatto.
- [ ] Un inventario `INCOMPLETE` blocca pilot e campagna.

## Protezione Artefatti

- [ ] Directory private `0700`; file privati `0600`, owner corretto e link
      count uno.
- [ ] State collector v2 e ledger supervisor v1 hanno path distinti.
- [ ] Config, baseline, coppie monitor, autorizzazione, aggregate, receipt,
      review e promotion output sono nuovi e non attraversano symlink.
- [ ] Nessun runner, advertiser o lock radio e gia attivo.
- [ ] Il servizio `cassav5bt.service` non viene fermato, riavviato, ricaricato
      o ridistribuito durante la prova.

## Pilot Diagnostico

- [ ] Postazione completa uno smoke separato, non contato.
- [ ] State e ledger hanno suffisso `diagnostic` e non saranno riusati.
- [ ] Collector `--init`, supervisor `--init` e `--preflight` completano PASS.
- [ ] Una sola `--capture` del supervisor raggiunge `ACTIVE`, quattro
      PING/PONG totali e `CLOSE/CLOSE_ACK`.
- [ ] `--status` mostra un solo record committed, zero errori e cleanup.
- [ ] Zero sessioni GATT, timer e segreti dopo il close; processi e servizi
      restano attivi.
- [ ] Lo state diagnostico non viene finalizzato o importato nella campagna.

## Autorizzazione Campagna

- [ ] Il collector crea un nuovo state schema v2 vuoto.
- [ ] Il supervisor crea un nuovo ledger schema v1 sul medesimo
      `campaignRunId`.
- [ ] L'autorizzazione B0-B4 e emessa prima del primo tentativo registrato nel
      ledger, quindi non oltre `coverageFromMs`.
- [ ] Lo SHA-256 del `campaignRunId`, la matrice, il bundle B0-B4 e il
      commitment nonzero dell'operatore sono correttamente legati.
- [ ] B0-B4 sono tutti `PASS`; stesso Palmare, build e account sono accettati.
- [ ] Continuita Android, continuita Raspberry, servizio principale continuo
      e review indipendente risultano obbligatori.
- [ ] L'autorizzazione lascia B5 e B6 `PENDING`.

## Baseline E Monitor

- [ ] Le config Android e Raspberry usano lo stesso `campaignRunId` privato e
      una durata `6000000..14400000 ms` sufficiente.
- [ ] La baseline Android vincola target, APK, user, UID, PID, reporter,
      sessione e ApplicationExitInfo.
- [ ] La baseline Raspberry vincola boot ID e snapshot di
      `cassav5bt.service` e `bluetooth.service`.
- [ ] Entrambi i monitor partono prima del primo tentativo e terminano dopo
      l'ultimo, coprendo `coverageFromMs..coverageUntilMs`, timeout e riprese.
- [ ] Il monitor Android usa esclusivamente ruolo `handheld` e Palmare Advanced
      certificato per la campagna ufficiale.
- [ ] Il numero di campioni usa `ceil(duration/poll)+1`; l'ultima scadenza e
      clampata a `durationMs`, anche con durata non divisibile per il poll.
- [ ] Il monitor Raspberry controlla clock, `MainPID`, `NRestarts`,
      `ActiveEnterTimestampMonotonic` ed `ExecMainStartTimestampMonotonic`.
- [ ] Nessun monitor viene interrotto; entrambi terminano naturalmente PASS.
- [ ] Ogni monitor pubblica risultato privato e attestazione come coppia
      accoppiata tramite `<private-output>.publication-v1.journal.json`.
- [ ] Un journal di pubblicazione residuo viene recuperato rieseguendo la stessa
      CLI; digest/path/campagna diversi e overwrite falliscono chiusi.
- [ ] Le attestazioni redatte non contengono seriali, hostname, PID, path,
      account, identificatori o materiale crittografico.

## Slot 001-100

- [ ] Tutti i capture ufficiali passano soltanto dal supervisor.
- [ ] Una sola `--capture` e in esecuzione; `--status` segue ogni tentativo.
- [ ] Si raccolgono esattamente 100 record `COMMITTED`, non 100 tentativi.
- [ ] Ogni capture usa un `bootId` casuale nuovo e privato.
- [ ] Ogni record completa `ACTIVE`, quattro PING/PONG, close e cleanup.
- [ ] Ledger e collector restano legati alla stessa campagna e allo stesso
      count dopo ogni evento.

## Retry, Recovery E Invalidazione

- [ ] Solo `DIRECT_CONTROL_ORCHESTRATION_TIMEOUT`, con cleanup verificato e
      count invariato, produce `RADIO_TIMEOUT` sullo stesso slot.
- [ ] Un `COMMITTED` azzera il contatore dei timeout consecutivi.
- [ ] Tre timeout consecutivi producono `SUSPENDED`.
- [ ] `--resume` e usato soltanto nella stessa finestra di entrambi i monitor,
      senza cambiare baseline o target.
- [ ] Una regressione del clock durante `--resume` produce `INVALIDATED` e non
      riattiva il ledger.
- [ ] Un journal incompleto viene recuperato con `--resume` prima di altri
      tentativi.
- [ ] Ogni altro errore, cleanup incompleto, clock regressivo, tamper,
      hardlink/symlink o conflitto recovery produce `INVALIDATED`.
- [ ] Crash, ANR, logout, force-stop, ADB gap, cambio PID/reporter/user/package/
      APK/account invalidano immediatamente.
- [ ] Reboot, gap Raspberry, restart/transizione servizio o incremento
      `NRestarts` invalidano immediatamente.
- [ ] Una campagna invalidata viene archiviata senza edit/delete; la nuova
      riparte da `001` con tutti gli artefatti nuovi.

## Gate Tecnico

- [ ] A `100/100` il ledger e `COMPLETE` e il collector finalizza un manifest
      nuovo senza overwrite.
- [ ] Entrambe le attestazioni coprono dal primo tentativo all'ultimo, non solo
      dal primo all'ultimo record `COMMITTED`.
- [ ] Il gate riceve manifest, campaign state, attempt state, attestazione
      Android `handheld`, attestazione Raspberry e autorizzazione B0-B4 della
      stessa campagna.
- [ ] `--output` e `--technical-receipt` sono path distinti, nuovi e nella
      stessa directory privata.
- [ ] Aggregate e receipt vengono pubblicati come coppia immutabile `0600`; un
      conflitto o errore di pubblicazione esegue rollback senza overwrite.
- [ ] Il receipt rispetta
      `contracts/b5-technical-receipt-v1.schema.json` e lega gli SHA-256
      byte-exact di aggregate, state, authorization, matrice e attestazioni.
- [ ] Il receipt lega anche campaign/collection commitment, attempt ledger
      head, prerequisite bundle e operator commitment.
- [ ] Il risultato e `TECHNICAL_PASS` con `b5TechnicalGate: PASS`.
- [ ] Il risultato tecnico conserva `b5HundredSessionGate: PENDING_REVIEW` e
      `b6: PENDING`; B5 resta ufficialmente `PENDING`.

## Review E Promozione

- [ ] Lo SHA-256 e calcolato sui byte esatti dell'aggregato tecnico.
- [ ] Aggregate e receipt restano immutati e vengono entrambi forniti al
      promotion gate tramite `--technical-aggregate` e `--technical-receipt`.
- [ ] Il parser dell'aggregato rifiuta campi mancanti, extra, incompleti o non
      canonici.
- [ ] La review privata e successiva all'aggregato e legata al suo SHA-256,
      allo stesso bundle B0-B4 e allo stesso commitment operatore.
- [ ] Il commitment del revisore e nonzero e distinto da quello operatore.
- [ ] Review PASS: integrita, B0-B4, tentativi, continuita Android/Raspberry,
      cleanup/ripristino e privacy.
- [ ] Assenza o mismatch di aggregate, receipt o sign-off lascia B5 `PENDING`.
- [ ] Solo `run-b5-promotion-gate.mjs` con review indipendente valida produce
      `b5HundredSessionGate: PASS`.
- [ ] Anche il report di promozione conserva B6 `PENDING`.

## Ripristino

- [ ] Postazione completa lo smoke diagnostico separato successivo.
- [ ] Palmare normale SHA-256
      `a1f10e89f0d91be57fe240b9f6295f7c28895448bda14952fd5bc0e5630d5b30`.
- [ ] Postazione normale SHA-256
      `be297b3223fcbff45ff68245ab049a8c37fc83943376dd4a610d8cd82cc18769`.
- [ ] Reinstallazione con `adb install -r -g`; dati ed enrollment restano.
- [ ] Reporter Lab assente; nessun runner, advertiser o lock residuo.
- [ ] Health e snapshot del servizio principale invariati, senza restart.
- [ ] B6 inizia soltanto dopo una promozione B5 formalmente valida.
