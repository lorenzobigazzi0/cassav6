# B5.3 Raspberry physical GATT smoke

Data: 2026-07-20

## Decisione

- preflight BlueZ/GattManager1: PASS;
- RegisterApplication fisico: PASS;
- consumo ObjectManager da parte di BlueZ: PASS;
- profilo con 8 oggetti e 7 caratteristiche: PASS;
- traffico pre-sessione: zero;
- UnregisterApplication fisico: PASS;
- cleanup bus, export, match rule e owner: PASS;
- stato discovery preservato: PASS;
- client GATT Android: non iniziato;
- gate B5 da 100 sessioni: PENDING.

Il PASS certifica soltanto il lifecycle GATT Raspberry. Non apre una sessione,
non attiva advertising e non promuove B4 o B5.

## Target

```text
host: raspberrypi (192.168.0.67)
architettura: arm64
Node.js: 24.15.0
BlueZ: 5.82
adapter: hci0
```

Il test e stato eseguito da uno staging isolato sotto `/home/admin`. Non sono
state installate unita systemd, non e stato modificato `/opt` e i processi
della cassa sono rimasti attivi.

## Harness

`raspberry/scripts/run-b5-raspberry-gatt-smoke.mjs` apre direttamente
`DbusNextGattServerPort`, verifica il preflight e registra l'applicazione.
`GattApplication` conta le richieste `GetManagedObjects`: il valore fisico
`1` dimostra che BlueZ ha consumato l'albero prima di accettare la
registrazione.

Una connessione utente separata non puo introspezionare l'owner univoco
dell'applicazione sul system bus: la policy D-Bus risponde `AccessDenied`.
La policy non e stata allentata. Le chiamate caratteristiche reali restano
quindi responsabilita del futuro client Android; i test locali e ARM64
continuano a verificare che ReadValue, WriteValue, StartNotify e StopNotify
falliscano con `org.bluez.Error.NotAuthorized`.

## Evidenza

File:

```text
reports/physical/v5bt-b5-3-gatt-smoke-20260720.json
```

SHA-256 locale e remoto:

```text
15228ad4588e6e0a430a0beef942fc2dcde2924ac0d79af7b7e8eac55f5df2d4
```

Misure:

```text
RegisterApplication: 1
GetManagedObjects osservati: 1
managed objects: 8
caratteristiche: 7
durata: 1581 ms
sessioni aperte: 0
UnregisterApplication: 1
discovery modificata: no
```

## Validazione

```text
npm test (Windows)
54 passati, 0 falliti

test GATT mirati Raspberry ARM64
12 passati, 0 falliti

harness self-test Raspberry ARM64
PASS, physicalRadioAccessed=false

harness fisico Raspberry ARM64
PASS
```

## Cleanup

Dopo il test:

```text
bluetooth.service: active
cassav5bt-bluetooth-node.service: non installata/inattiva
Adapter1.Discovering: false
processi harness Node residui: 0
connessioni D-Bus Node residue: 0
override runtime GATT: assente
```

Il flag di distribuzione resta
`CASSA_BT_GATT_SERVER_ENABLED=0`.

