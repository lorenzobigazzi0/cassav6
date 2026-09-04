# B0 checklist

Matrice di laboratorio: `configs/device-capability-matrix.json`.

## Contratto dell'evidenza

- [ ] Ogni record dichiara `FORMAL`, `SUPPLEMENTAL` o `NON_GATE_EVIDENCE`.
- [ ] Soltanto i record `FORMAL` concorrono al gate.
- [ ] Sono presenti almeno un `handheld` e una `station` formali.
- [ ] Il report esportabile dichiara `PUBLIC_ALLOWLIST_V1` e non contiene
      seriali, indirizzi radio, enrollment, percorsi o identificatori privati.

## Controlli obbligatori per ogni nodo formale

- [ ] `scan: PASS`
- [ ] `advertise: PASS`
- [ ] `gattClient: PASS`
- [ ] `gattServer: PASS`
- [ ] `scanAdvertiseConcurrent: PASS`
- [ ] `wifiBleCoexistence: PASS`
- [ ] `backgroundForeground: PASS`
- [ ] `classification: FULL_NODE`

Qualsiasi campo assente, `UNKNOWN`, `NOT_TESTED`, `NOT_APPLICABLE`, `FAIL` o
non valido mantiene B0 in `PENDING`. Un nodo supplementare non puo sostituire
uno dei due ruoli formali.

## Esecuzione

```bash
node scripts/generate-device-capability-report.mjs --root .
```

Il comando termina con codice `0` soltanto per `PASS`, `2` per `PENDING` e `1`
per matrice non valida o non disponibile. L'output JSON su stdout e sempre
redatto. Un'eventuale matrice esterna con `privateEvidence` deve avere permessi
`0600`, un solo hard link e deve essere passata con `--matrix`; non va salvata
nelle configurazioni versionate. `privateEvidence` non viene mai serializzato
nel report.

## Cattura formale Palmare/Postazione

Il runner formale usa esclusivamente i due ruoli e le build dichiarati in
`configs/advanced-certification-targets.json`. Richiede due seriali ADB
espliciti e distinti; il ruolo non viene dedotto dal modello del dispositivo:

```bash
install -d -m 700 /secure/path/b0-formal-private
node scripts/run-b0-android-formal-gate.mjs \
  --adb /absolute/path/to/adb \
  --handheld-serial PALMARE_SERIAL \
  --station-serial POSTAZIONE_SERIAL \
  --private-output /secure/path/b0-formal-private/evidence.json \
  --report-output /secure/path/b0-formal-redacted-report.json
```

La cattura dura 120 secondi, con 30 secondi in foreground e 90 in background.
Per entrambi i ruoli richiede i sette controlli B0, classificazione `FULL_NODE`,
modello fisso (`SM-A165F` per Palmare, `SM-T503` per Postazione), versione,
codice e SHA-256 certificati, server GATT provato sia dal probe
open/close sia a runtime e continuita completa di package, utente, processo,
reporter, sessione, crash/ANR, clock, polling e servizio. Campi assenti,
`UNKNOWN` o non misurati falliscono chiuso.

Soltanto una coppia Palmare/Postazione integralmente valida produce
`evidenceClass=FORMAL`, `gateImpact=GATE_EVIDENCE` e `formalGate=PASS`. Una
coppia errata, un controllo fallito, un binding cambiato o un ripristino
incompleto produce esclusivamente `NON_GATE_EVIDENCE` e mantiene il gate
`PENDING`. Il report pubblico usa `PUBLIC_ALLOWLIST_V1`; l'evidenza privata e
il report redatto sono pubblicati con permessi `0600` e senza sovrascrittura.

Il preflight seguente e interamente offline, non invoca ADB e mostra il binding
alla matrice corrente:

```bash
node scripts/run-b0-android-formal-gate.mjs --dry-run
node --test scripts/run-b0-android-formal-gate.test.mjs
```

## Cattura supplementare con due Palmari

Se la Postazione formale non e disponibile, il runner seguente acquisisce
evidenza fisica supplementare da due Palmari distinti senza cambiare i ruoli
certificati:

```bash
install -d -m 700 /secure/path/b0-private
node scripts/run-b0-android-supplemental-gate.mjs \
  --adb /absolute/path/to/adb \
  --primary-serial PRIMARY_SERIAL \
  --secondary-serial SECONDARY_SERIAL \
  --private-output /secure/path/b0-private/evidence.json \
  --report-output /secure/path/b0-redacted-report.json
```

La cattura ha durata fissa di 120 secondi: 30 in foreground e 90 in
background. Per entrambi i target misura separatamente tutti i sette controlli
B0 e la continuita di package/versione, utente Android, processo, reporter,
sessione autenticata, crash/ANR, clock, polling e servizio. Un controllo non
misurato o non riuscito produce `SUPPLEMENTAL_FAIL`.

Il server GATT e provato esclusivamente dall'esito esplicito del probe nativo
open/close (`gattServerOpen=true`): non richiede uno stato server persistente
nel connectivity agent. Il client GATT resta indipendente e passa soltanto con
reporter progressivo e attivita di connessione reale verso un annuncio
Raspberry eleggibile. La concorrenza scan/advertise richiede un delta positivo
del contatore process-lifetime `concurrentScanAdvertiseWindowsStarted` sia in
foreground sia in background; campo assente, nullo o fermo fallisce chiuso.

L'evidenza resta sempre `SUPPLEMENTAL` / `NON_GATE_EVIDENCE`: non puo sostituire
la Postazione formale, mantiene `formalGate=PENDING_UNCHANGED` e non promuove
B0 anche quando tutti i controlli supplementari passano. Il file privato e il
report redatto sono pubblicati come coppia distinta, con permessi `0600`, senza
seriali o identificatori privati e senza possibilita di sovrascrittura. Il
runner non esegue `force-stop`, uninstall, cancellazione dati o cambio utente e
ripristina lo stato foreground/background osservato prima della cattura.

Le modalita seguenti sono interamente offline e non accedono ad ADB:

```bash
node scripts/run-b0-android-supplemental-gate.mjs --dry-run
node scripts/run-b0-android-supplemental-gate.mjs --self-test
node --test scripts/run-b0-android-supplemental-gate.test.mjs
```
