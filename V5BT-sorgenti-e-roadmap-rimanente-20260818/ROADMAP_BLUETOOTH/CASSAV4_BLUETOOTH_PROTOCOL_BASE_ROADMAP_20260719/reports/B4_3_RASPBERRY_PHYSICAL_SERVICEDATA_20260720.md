# B4.3 Raspberry Physical ServiceData

Data: 2026-07-20

## Decisione

- Callback `Device1.ServiceData` da un Palmare fisico: PASS
- Incremento B4.3 con un advertiser controllato: PASS
- Cleanup scanner e D-Bus dopo la prova: PASS
- Gate B4 con 10 dispositivi fisici distinti consecutivi: PENDING
- Sessione diretta GATT B5: non iniziata

B4.3 certifica il percorso radio Palmare -> BlueZ -> processo V5BT. Non
promuove il gate B4 completo e non usa la rotazione degli alias come se
rappresentasse dispositivi fisici diversi.

## Correzione emersa dalla prova fisica

Su BlueZ 5.82, `SetDiscoveryFilter(UUIDs=...)` non consegnava al processo gli
advertisement Android che espongono l'UUID soltanto nella mappa
`ServiceData`. Il controller vedeva i frame, ma il callback applicativo non
riceveva aggiornamenti utilizzabili.

Il filtro BlueZ effettivo usa ora:

```text
Transport     = le
DuplicateData = true
```

`BluezAdapter` continua a filtrare in modo autorevole l'UUID V1 prima di
decodificare o registrare un peer. Il cambiamento amplia soltanto gli eventi
D-Bus osservati dal processo e non amplia il protocollo accettato.

## Runner

Il gate e posseduto da:

```text
raspberry/scripts/run-b4-raspberry-servicedata-gate.mjs
```

Il runner:

- forza esplicitamente feature attiva e dry-run disattivo nel solo processo
  figlio;
- osserva la radio per 90 secondi;
- richiede almeno un advertisement Android V1 valido;
- verifica capability B2, RSSI, manutenzione e pruning;
- fallisce su errori D-Bus, payload invalidi, conflitti di sequenza o leak;
- termina con `SIGTERM` e certifica il rilascio di scanner, bus, match rule,
  device cache e timer di retry;
- genera un report redatto privo di MAC, alias, NodeId e payload.

Il test di regressione del runner copre inoltre log incompleti, durata
insufficiente, advertiser non Android, assenza di ServiceData, errori runtime
e ogni risorsa di cleanup.

## Prova fisica

Target:

```text
Raspberry: ARM64, BlueZ 5.82
Advertiser: Palmare Advanced 1.0.22, nodeKind handheld
Durata richiesta: 90 s
Durata a parete: 90141 ms
```

Risultato:

```text
osservazioni totali: 259
osservazioni accettate: 259
osservazioni rifiutate: 0
RSSI corrente osservato: -58 dBm
passaggi di pruning: 90
stream scaduti realmente rimossi: 1
errori scanner/D-Bus/payload/sequenza: 0
Discovering finale: no
ActiveInstances finale: 0
```

Il `peerStreamHighWatermark` e 2 per effetto della rotazione dell'alias
durante la stessa prova. Il numero di dispositivi fisici certificati resta
esattamente 1.

## Evidenze

Report redatto:

```text
reports/physical/v5bt-b4-3-servicedata-gate-20260720.json
```

Log tecnico sorgente:

```text
reports/physical/v5bt-b4-3-servicedata-node-20260720.log
```

SHA-256 del log:

```text
961e775900a5671dd2f351e6b886ac4de6865a671fcf799e31369f1a1f922f14
```

L'hash ricalcolato localmente coincide con `sourceLogSha256` nel report. La
ricerca di MAC Bluetooth, seriale ADB, IP e credenziali nelle due evidenze non
ha prodotto corrispondenze.

## Validazione

```text
npm run check: PASS
npm test: 25/25 PASS
runner self-test: PASS
gate fisico B4.3: PASS
stderr del runner fisico: 0 byte
cleanup finale BlueZ: PASS
```

Nessuna unit systemd e stata installata o abilitata. Backend, database e
business logic CASSAv4 non sono stati modificati.

## Prossimo task

Eseguire lo stesso gate con 10 dispositivi Android fisici distinti e
controllati, uno dopo l'altro, producendo identita operatore redatte e prova
di cleanup finale. Soltanto dopo quel PASS si puo chiudere B4 e iniziare B5,
sessione diretta Android-Raspberry.
