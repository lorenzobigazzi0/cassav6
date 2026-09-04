# B5 Offline Campaign Governance - 2026-08-03

## Esito

Il secondo giro offline chiude le lacune di governo della futura campagna B5:
retry ora posseduti da un supervisor persistente, continuita Raspberry
attestata e promozione separata dal risultato tecnico.

Nessun hardware e stato contattato. Non sono stati eseguiti ADB, SSH,
Bluetooth, letture UPS, installazioni, deploy o operazioni su servizi reali.
Le fixture e i self-test non sono evidenza fisica. B5 e B6 restano `PENDING`
e l'avanzamento ufficiale resta **49%**.

L'incremento modifica soltanto contratti e strumenti Lab. API business,
server operativo, database e build normali delle app non cambiano.

## Supervisor Campagna

`raspberry/scripts/run-b5-campaign-supervisor.mjs` espone:

```text
--init
--preflight
--capture
--resume
--status
```

Ogni modalita operativa richiede `--ledger PRIVATE.json` e
`--state COLLECTOR.json`. Il ledger schema v1 e distinto dallo state collector
schema v2 e legato allo stesso `campaignRunId`.

La policy e deterministica:

| Risultato | Condizione | Effetto |
| --- | --- | --- |
| `COMMITTED` | collector incrementato di uno e cleanup verificato | avanza slot, azzera timeout consecutivi |
| `RADIO_TIMEOUT` | solo `DIRECT_CONTROL_ORCHESTRATION_TIMEOUT`, cleanup vero, count invariato | stesso slot ritentabile |
| `SUSPENDED` | terzo timeout consecutivo | nessun capture fino a `--resume` |
| `INVALIDATED` | ogni altro errore o cleanup incompleto | campagna non promuovibile |

Il supervisor conserva hash-chain degli eventi, ordinali di slot e tentativo,
count collector prima/dopo e journal transazionale. Scritture atomiche,
recovery post-commit, file `0600`, owner/link count, symlink, hardlink,
clock regressivo, manomissione e overwrite sono verificati fail-closed.

La ripresa dopo sospensione e consentita operativamente solo nella stessa
finestra dei monitor. La copertura temporale viene poi rivalidata dal gate;
una nuova baseline richiede una nuova campagna.

## Continuita Raspberry

`scripts/run-b5-raspberry-continuity-monitor.mjs` espone
`--capture-baseline` e `--monitor`. Usa path assoluti per `systemctl` e
`boot_id`, una config privata legata alla campagna e polling `1000..5000 ms`.

Controlli continui:

- `cassav5bt.service` e `bluetooth.service` sempre `active/running`;
- boot ID invariato e clock non regressivo;
- `MainPID` invariato;
- `NRestarts` invariato;
- `ActiveEnterTimestampMonotonic` invariato;
- `ExecMainStartTimestampMonotonic` invariato;
- nessun gap o restart rapido tra due poll.

L'output completo resta privato. L'attestazione esportabile e legata al
commitment della campagna e dichiara la copertura temporale, ma esclude
hostname, PID, path e identificatori.

## Inventario Read-Only

`scripts/run-v5bt-bench-inventory.mjs`, nella root workspace, usa una
allowlist fissa e produce un report privato e un riepilogo redatto. Copre:

- ADB e inventario esatto dei target previsti;
- Android user, API, package, versione/code, SHA-256 e permessi Bluetooth;
- sessione autenticata, identita enrollata e binding con registry;
- Raspberry, architettura, BlueZ, adapter e NTP;
- servizi V5BT, registry, transazioni enrollment e permessi;
- discovery UPS e unita di servizio osservate.

La parte UPS e deliberatamente `DISCOVERY_ONLY`. Non viene interrogato un
modello proprietario, non viene scelto un protocollo e non viene implementato
un driver prima di vedere l'hardware reale.

## Coerenza Build

`scripts/verify-v5bt-advanced-build-consistency.mjs` confronta matrice,
identita Gradle, SHA-256 degli APK certificati e parita dei sorgenti/test
Bluetooth condivisi. La sola differenza applicativa ammessa resta quella
dichiarata dal verificatore per il servizio di failover dipendente dal ruolo.
Ogni altra divergenza fallisce chiusa.

## Autorizzazione E Review

`scripts/b5-campaign-governance.mjs` valida due contratti esatti:

- `contracts/b5-campaign-authorization-v1.schema.json`;
- `contracts/b5-review-attestation-v1.schema.json`.

L'autorizzazione impegna campagna, matrice, bundle di evidenze B0-B4 e
operatore. Richiede B0-B4 tutti PASS e accetta esplicitamente i vincoli di
continuita e review. Deve precedere il primo capture e non puo promuovere B5.

La review impegna lo SHA-256 dei byte esatti dell'aggregato tecnico, lo stesso
bundle B0-B4 e lo stesso commitment operatore. Il commitment revisore deve
essere nonzero e distinto; la review deve essere successiva all'aggregato e
deve approvare integrita, tentativi, continuita, cleanup e privacy.

## Due Gate Separati

`raspberry/scripts/run-b5-hundred-session-gate.mjs` richiede:

```text
manifest fisico 100/100
collector state v2
attempt ledger v1 COMPLETE
attestazione Android PASS
attestazione Raspberry PASS
autorizzazione B0-B4 valida
```

Verifica legame uno-a-uno tra i cento eventi `COMMITTED` e i cento record del
collector, copertura completa di entrambi i monitor, hash e timeline. Il suo
massimo esito e:

```text
TECHNICAL_PASS
b5TechnicalGate: PASS
b5HundredSessionGate: PENDING_REVIEW
b6: PENDING
```

`raspberry/scripts/run-b5-promotion-gate.mjs` e un passaggio distinto. Legge
l'aggregato tecnico come byte, ricalcola lo SHA-256 e convalida state,
autorizzazione e review. Solo questo gate, con revisore indipendente, puo
produrre `b5HundredSessionGate: PASS`. B6 resta `PENDING` anche nel report di
promozione.

## Verifica Offline

Le nuove suite coprono timeout singolo, tre timeout, reset dopo successo,
errore invalidante, cleanup incompleto, recovery, ledger alterato, restart
rapido e tra slot, cambio PID, incremento `NRestarts`, reboot, clock
regressivo, gap di polling, attestazione incompleta, sign-off assente o
mismatched e review non indipendente.

Risultati consolidati del giro:

```text
Suite Raspberry con build TypeScript: 188/188 PASS
Gate tecnico B5:                     31/31 PASS
Promotion gate B5:                    7/7 PASS
Monitor Raspberry mirato:            17/17 PASS
Governance mirata:                     4/4 PASS
Inventario read-only su fixture:       5/5 PASS
Contratti JSON:                       19/19 PASS
Shared:                              128/128 PASS
Scripts roadmap:            105 PASS, 2 SKIP, 0 failure
Coerenza build Advanced:               5/5 PASS
```

Comandi mirati:

```bash
node --test raspberry/test/b5-campaign-supervisor.test.mjs
node --test scripts/run-b5-raspberry-continuity-monitor.test.mjs
node --test scripts/b5-campaign-governance.test.mjs
node --test raspberry/test/b5-hundred-session-gate.test.mjs
node --test raspberry/test/b5-promotion-gate.test.mjs

# dalla root del workspace
node --test tests/run-v5bt-bench-inventory.test.mjs
node --test tests/verify-v5bt-advanced-build-consistency.test.mjs
node scripts/verify-v5bt-advanced-build-consistency.mjs --root .
```

Nessun PASS sintetico cambia lo stato ufficiale dei gate.

## Ripresa Fisica

Alla riconnessione: inventario read-only, verifica build, recupero B0-B4,
pilot diagnostico separato, nuova autorizzazione, supervisor e due monitor
continui. Dopo `100/100`: finalizzazione, risultato tecnico, review umana
indipendente e solo allora eventuale promozione B5. B6 resta chiusa fino a
questa sequenza completa.
