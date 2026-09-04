# Raspberry GATT server B5.2

## Confine

Il runtime Raspberry registra l'applicazione GATT tramite il boundary:

```text
BluezNode
  -> BluezGattServerPort
    -> DbusNextGattServerPort
      -> org.bluez.GattManager1
```

`GattApplication` possiede soltanto l'albero D-Bus. `CassaGattService`
deriva servizio, caratteristiche, UUID e flag dal profilo eseguibile
`shared/protocol/gatt-profile-v1.mjs`.

## Feature gate

La registrazione richiede entrambi:

```text
CASSA_BT_FEATURE_ENABLED=1
CASSA_BT_GATT_SERVER_ENABLED=1
```

Il secondo flag e `0` per default anche nell'unita systemd. In dry-run non
viene aperta alcuna risorsa radio o D-Bus.

## Lifecycle

Il port serializza start, stop e recovery:

```text
STOPPED -> STARTING -> REGISTERED
REGISTERED -> RECOVERING -> REGISTERED
REGISTERED -> STOPPING -> STOPPED
errore non recuperabile -> FAILED
```

Prima di `RegisterApplication` esporta ObjectManager, servizio e sette
caratteristiche. Lo stop annulla retry, esegue `UnregisterApplication`,
rimuove gli export e la match rule, quindi disconnette il bus. La perdita
dell'owner `org.bluez` invalida la registrazione e il ritorno di BlueZ avvia
un retry con backoff limitato.

## Introspezione D-Bus

La versione fissata di `@jellybrick/dbus-next` installa i membri configurati
sul prototype ma crea mappe omonime vuote sull'istanza. Le interfacce GATT
rimuovono queste sole proprieta ombra subito dopo il costruttore base, cosi
l'introspezione usata da BlueZ espone metodi e proprieta reali. I test
ispezionano il documento D-Bus risultante, inclusi `GetManagedObjects`,
`ReadValue`, `WriteValue`, `StartNotify` e `StopNotify`.

## Barriera di sicurezza

B5.2 non collega il core sessione B5.1 e non accetta traffico. Tutti i metodi
ReadValue, WriteValue, StartNotify e StopNotify rispondono
`org.bluez.Error.NotAuthorized`. Gli snapshot non contengono payload,
identita, indirizzi Bluetooth o materiale crittografico.

## Limiti

Non sono ancora implementati:

- handshake Ed25519/X25519/HKDF/AEAD;
- binding della sessione alle caratteristiche;
- client GATT Android;
- heartbeat o messaggi business;
- gate fisico delle 100 sessioni.

## Smoke fisico B5.3

L'harness `raspberry/scripts/run-b5-raspberry-gatt-smoke.mjs` usa il port
reale in staging e non il runtime cassa. Il PASS richiede:

```text
RegisterApplication = 1
GetManagedObjects da BlueZ >= 1
managed objects = 8
caratteristiche = 7
UnregisterApplication = 1
bus/export/match rule/retry finali = 0
sessioni aperte = 0
```

Il contatore ObjectManager e di sola telemetria e non contiene payload. Una
seconda connessione utente non viene autorizzata a introspezionare direttamente
l'owner univoco sul system bus; la policy D-Bus non viene indebolita. Il client
Android B5.4 esercitera le chiamate GATT fisiche.
