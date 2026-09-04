# Raspberry BlueZ model

Usare D-Bus ufficiale BlueZ:

```text
Adapter1 per discovery
LEAdvertisingManager1 per advertising
GattManager1 per servizio GATT
Device1 per peer state
```

Evitare accesso diretto allo storage BlueZ.

## Scanner B4.2

Il boundary infrastrutturale e:

```text
BluezNode
  -> PeerScanner
    -> BluezAdapter
      -> BluezDbusPort
        -> DbusNextBluezPort
          -> system bus / org.bluez
```

`DbusNextBluezPort` possiede la connessione D-Bus e usa una sola subscription
ai segnali, non un proxy/listener per ogni device. `BluezAdapter` combina
RSSI e ServiceData per object path, ma nessun path o indirizzo Bluetooth viene
esposto nelle metriche.

Il filtro BlueZ non e considerato un confine di sicurezza: i filtri discovery
di client diversi vengono uniti da BlueZ. L'UUID v1 viene quindi verificato
nuovamente nell'adapter e nello scanner.

Alla perdita dell'owner `org.bluez`, la cache volatile viene svuotata e la
sessione e considerata rilasciata. Al ritorno dell'owner, l'adapter ripete
risoluzione, filtro e `StartDiscovery` con backoff deterministico. Lo stop
cancella il retry, rilascia la sessione e rimuove tutte le match rule.

## Server GATT B5.2

Il boundary del server GATT e separato da scanner e sessione:

```text
BluezNode
  -> BluezGattServerPort
    -> DbusNextGattServerPort
      -> org.bluez.GattManager1
```

`GattApplication` possiede l'albero D-Bus richiesto da BlueZ:
ObjectManager alla radice, un `GattService1` e sette
`GattCharacteristic1`. `CassaGattService` costruisce percorsi, UUID e flag
dal profilo condiviso e non conosce D-Bus, sessioni o trasporto.

La registrazione e attiva solo quando entrambi i flag sono a `1`:

```text
CASSA_BT_FEATURE_ENABLED
CASSA_BT_GATT_SERVER_ENABLED
```

Il flag GATT e `0` per default. Start, stop e recovery sono serializzati. Un
errore iniziale esegue il rollback di registrazione, export, match rule e bus.
Alla perdita dell'owner `org.bluez` la registrazione viene invalidata; al suo
ritorno viene ripetuta con backoff deterministico. Lo stop annulla ogni retry
pendente.

B5.2 mantiene il data plane chiuso: nessun metodo caratteristica accetta dati
prima di una sessione autenticata e nessuno snapshot espone payload, identita,
indirizzi Bluetooth o materiale crittografico.
