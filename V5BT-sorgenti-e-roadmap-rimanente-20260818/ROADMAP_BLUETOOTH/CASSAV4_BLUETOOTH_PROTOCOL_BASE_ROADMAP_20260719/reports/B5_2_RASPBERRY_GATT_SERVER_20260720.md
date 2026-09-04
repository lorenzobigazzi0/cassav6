# B5.2 Raspberry GATT server

Data: 2026-07-20

## Decisione

- profilo GATT v1 eseguibile: PASS locale;
- albero ObjectManager/servizio/caratteristiche: PASS locale;
- lifecycle RegisterApplication/UnregisterApplication: PASS locale;
- recovery dopo perdita owner BlueZ: PASS simulato;
- integrazione BluezNode e rollback: PASS locale;
- registrazione su BlueZ fisico Raspberry: PASS;
- cleanup fisico D-Bus/BlueZ: PASS;
- client GATT Android: non iniziato;
- gate B5 da 100 sessioni: PENDING.

## Implementazione

Il flag `CASSA_BT_GATT_SERVER_ENABLED` e separato dal flag Bluetooth generale
ed e disattivato per default. `NodeConfig` rifiuta valori ambigui e impedisce
di abilitarlo quando `CASSA_BT_FEATURE_ENABLED` e spento.

`DbusNextGattServerPort` esporta una radice ObjectManager, un servizio primario
e sette caratteristiche, quindi usa `org.bluez.GattManager1`. Start e stop
sono idempotenti e serializzati. Errori di registrazione effettuano rollback
di export, match rule e bus. La perdita di `org.bluez` porta a `RECOVERING`;
il ritorno dell'owner ripete la registrazione con backoff deterministico.

Tutti gli accessi alle caratteristiche restano fail-closed con
`org.bluez.Error.NotAuthorized`. Non viene importato o simulato il core
sessione, non vengono aperte sessioni e non vengono trasportati payload.

Il primo smoke fisico ha esposto un'incompatibilita di introspezione con
`@jellybrick/dbus-next@0.11.1`: i membri configurati sul prototype erano
oscurati da proprieta omonime dell'istanza e BlueZ non vedeva
`GetManagedObjects`. Il boundary D-Bus ora rimuove soltanto quelle proprieta
ombra dopo il costruttore base. Il test dell'applicazione verifica direttamente
l'introspezione di ObjectManager, servizio e caratteristiche, non soltanto le
chiamate JavaScript.

## Verifica locale

```text
npm test (raspberry)
54 test passati, 0 falliti

node --test shared/protocol/gatt-profile-v1.test.mjs \
  shared/session/direct-session-v1.test.mjs
21 test passati, 0 falliti

node scripts/validate-contracts.mjs --root .
PASS

node scripts/validate-roadmap-package.mjs --root .
PASS
```

## Verifica Raspberry ARM64

Backup precedente alla sincronizzazione:

```text
/home/admin/cassav5bt-backups/B5_2_GATT_20260720-145509
```

Risultati:

```text
validate-contracts: PASS
validate-roadmap-package: PASS
raspberry npm test: 50 passati, 0 falliti
shared Linux suite: 103 passati, 0 falliti

start:
state=REGISTERED
registered=true
busConnected=true
exportedInterfaceCount=9
activeMatchRules=1
registrationsTotal=1
characteristicCount=7

stop:
state=STOPPED
registered=false
busConnected=false
exportedInterfaceCount=0
activeMatchRules=0
retryScheduled=false
unregistersTotal=1

BlueZ finale:
Powered=yes
Discovering=no
ActiveInstances=0
```

Lo smoke fisico B5.3 di registrazione e cleanup e quindi `PASS`. Il report
autorevole aggiornato e
`reports/B5_3_RASPBERRY_GATT_PHYSICAL_20260720.md`; i test GATT mirati
passano 12/12 anche su ARM64.
Il gate B4 resta `PENDING` a 1/10. Il gate B5 resta `PENDING`.
