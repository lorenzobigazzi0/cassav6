# B5.3 Raspberry GATT physical smoke

## Scopo

Certificare su BlueZ reale il lifecycle del solo server GATT Raspberry:

```text
preflight
export ObjectManager
RegisterApplication
BlueZ legge GetManagedObjects
hold controllato
UnregisterApplication
cleanup completo
```

Il test non pubblicizza il nodo, non apre una sessione e non esegue il gate
da 100 connessioni.

## Prerequisiti

- Linux ARM64 con Node.js 24 o successivo;
- `bluetooth.service` attivo;
- adapter `hci0` acceso;
- `org.bluez.GattManager1` disponibile;
- build `raspberry/dist` allineato al sorgente;
- nessun altro processo che registri la stessa applicazione di test.

Eseguire da una directory di staging, non dal runtime cassa attivo.

## Comandi

Self-test senza radio:

```bash
cd raspberry
npm run gate:b5-gatt-smoke -- --self-test
```

Smoke fisico:

```bash
cd raspberry
npm run gate:b5-gatt-smoke -- \
  --adapter hci0 \
  --hold-ms 1500 \
  --output ../reports/physical/v5bt-b5-3-gatt-smoke.json
```

## Criteri PASS

- BlueZ accetta una registrazione;
- ObjectManager riceve almeno una richiesta da BlueZ;
- risultano esattamente 8 oggetti e 7 caratteristiche;
- nessuna operazione caratteristica raggiunge il server prima della sessione;
- BlueZ accetta una unregister;
- owner, bus, export, match rule e retry sono azzerati;
- lo stato `Discovering` finale coincide con quello iniziale;
- il report mantiene client Android `NOT_STARTED` e gate B5 `PENDING`.

## D-Bus

Non modificare la policy del system bus per interrogare direttamente l'owner
univoco da una seconda connessione utente. Il consumo autorevole dell'albero
e provato dal contatore `GetManagedObjects` invocato da BlueZ. Le chiamate
caratteristiche fisiche verranno esercitate dal client Android B5.4.

## Cleanup

Al termine verificare:

```bash
systemctl is-active bluetooth
busctl get-property org.bluez /org/bluez/hci0 \
  org.bluez.Adapter1 Discovering
pgrep -af run-b5-raspberry-gatt-smoke
```

Non installare o abilitare `cassav5bt-bluetooth-node.service` durante questo
smoke.
