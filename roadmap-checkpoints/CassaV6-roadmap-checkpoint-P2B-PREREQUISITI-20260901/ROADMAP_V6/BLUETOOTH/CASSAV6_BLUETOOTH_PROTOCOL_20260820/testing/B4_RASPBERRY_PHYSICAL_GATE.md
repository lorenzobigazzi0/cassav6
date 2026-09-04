# B4.3 Raspberry Physical ServiceData Gate

## Scope

Questo gate verifica un solo advertiser Android V1 fisico controllato:

```text
Android advertiser
-> BlueZ Device1.ServiceData
-> BluezAdapter
-> PeerDirectoryV1
-> cleanup completo
```

Non apre GATT, non autentica sessioni, non modifica backend o database e non
chiude il gate B4 complessivo. B4 richiede ancora 10 dispositivi fisici
distinti consecutivi; gli alias ruotati dello stesso dispositivo non contano.

## Prerequisiti

- Raspberry ARM64 con BlueZ e Node.js 24;
- checkout V6 isolato;
- un Palmare o una Postazione Advanced gia predisposti come advertiser V1;
- stato Android `READY` e `radioActive=true`;
- nessun altro runner B4 o nodo scanner temporaneo in esecuzione;
- baseline BlueZ con `Powered: yes`, `Discovering: no` e
  `ActiveInstances: 0`.

## Comandi

Dal Raspberry, nella directory `raspberry`:

```bash
npm ci
npm run check
npm test
npm run gate:b4-servicedata -- --self-test
npm run gate:b4-servicedata -- \
  --output ../reports/physical/v6-b4-3-servicedata-gate-20260720.json \
  --raw-log ../reports/physical/v6-b4-3-servicedata-node-20260720.log
```

Il run fisico dura esattamente 90 secondi e termina il processo figlio con
`SIGTERM`.

## Criteri PASS

- almeno 75 secondi nel clock monotono del nodo durante il run da 90 secondi;
- almeno un callback `Device1` e un'osservazione ServiceData V1 accettata;
- node kind Android valido, capability B2 complete e RSSI valido;
- almeno un passaggio di manutenzione;
- almeno uno stream scaduto realmente rimosso dal registry;
- zero errori adapter, scanner, D-Bus, payload e sequenza;
- scanner `STOPPED`, discovery disattivata, bus disconnesso;
- zero match rule, device tracciati e retry pendenti;
- una chiamata di stop BlueZ osservata;
- hash SHA-256 del log uguale a `sourceLogSha256` nel report.

Il report deve restare redatto: niente indirizzi Bluetooth, alias, NodeId o
payload. Il log tecnico va trattato come evidenza privata e conservato con
permessi owner-only.

## Stato dopo il test

Verificare nuovamente:

```bash
bluetoothctl show
pgrep -af 'run-b4-raspberry-servicedata-gate|ROADMAP_BLUETOOTH.*/dist/index.js'
```

Il risultato atteso e `Discovering: no`, `ActiveInstances: 0` e nessun
processo temporaneo. Un PASS B4.3 deve comunque riportare il gate a 10
dispositivi come `PENDING`.
