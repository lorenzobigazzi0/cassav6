# B4 Raspberry BlueZ Node Core

Data: 2026-07-20

## Decisione

- Incremento: B4.1 core lifecycle/discovery
- Implementazione software: PASS
- Gate fisico B4: PENDING

Il gate non viene promosso: il test a 10 peer e simulato e il binding BlueZ
D-Bus reale non e ancora implementato.

## Architettura

Il processo V5BT e identificato come `cassav5bt-bluetooth-node` per non
confonderlo con servizi V4. Non contiene logica POS e non accede a database,
pagamenti o fiscale.

Responsabilita implementate:

- `NodeConfig`: parsing centralizzato, valori stretti e default fail-closed;
- `BluezNode`: proprietario della macchina a stati e del timer manutenzione;
- `BluezAdapterPort`: confine infrastrutturale per BlueZ;
- `PeerScanner`: filtro UUID e inoltro delle osservazioni;
- `PeerRegistry`: adapter del `PeerDirectoryV1` condiviso;
- `MetricsRegistry`: metriche lifecycle, osservazioni, errori e leak.

Stati consentiti:

```text
DISABLED
IDLE -> STARTING -> DISCOVERING -> STOPPING -> STOPPED
                    |                        |
                    +-------> FAILED <-------+
FAILED -> STARTING
FAILED -> STOPPING
```

Le operazioni start/stop vengono serializzate. Il timer di pruning viene
creato solo dopo l'avvio dello scanner e viene sempre rimosso prima dello stop
dell'adapter.

## Sicurezza operativa

Default:

```text
CASSA_BT_FEATURE_ENABLED=0
CASSA_BT_DRY_RUN=1
```

Con feature disabilitata non viene costruito il nodo. Con dry-run non viene
costruito l'adapter. Se si forza feature live prima del task D-Bus, il
trasporto restituisce `BLUEZ_DBUS_BINDING_NOT_IMPLEMENTED` ed esce con codice
1 senza aprire risorse radio.

## Validazione locale

```text
npm run check: PASS
npm test: 6/6 PASS
npm audit: 0 vulnerabilita
shared B1/B2 suites: 50/50 PASS
validate-contracts: PASS, 15 contratti
validate-roadmap-package: PASS
```

Lo scenario principale:

1. avvia un adapter in-memory;
2. emette 10 advertisement validi con alias distinti;
3. verifica 10 osservazioni accettate e high-watermark 10;
4. avanza il clock oltre 15.000 ms;
5. esegue il pruning e verifica zero peer residui;
6. arresta il nodo e verifica zero listener e zero timer.

Sono coperti anche feature disabilitata, configurazione invalida, UUID
estraneo e fallimento di startup dell'adapter.

## Validazione Raspberry ARM64

Host:

```text
192.168.0.67
```

Runtime:

```text
Node.js 24.15.0 arm64
```

Esito:

```text
test B4.1: 6/6 PASS
prima: Discovering=no, ActiveInstances=0
dopo:  Discovering=no, ActiveInstances=0
backend V5BT: ok=true, database.mode=mysql
```

Non e stata installata o avviata alcuna unit systemd Bluetooth. V4 e runtime
V5BT esistenti non sono stati riavviati.

## Rollback

La feature resta disabilitata. Il rollback operativo consiste nel non
installare il futuro servizio e nel mantenere
`CASSA_BT_FEATURE_ENABLED=0`. Non esistono migrazioni dati o stato radio
persistente introdotti da B4.1.

## Prossimo task

B4.2 deve implementare `BluezAdapterPort` tramite D-Bus:

- risoluzione autorevole di `/org/bluez/hci0`;
- `SetDiscoveryFilter` LE con UUID v1;
- `StartDiscovery` e `StopDiscovery` idempotenti;
- ingestione `InterfacesAdded` e `PropertiesChanged`;
- gestione `InterfacesRemoved`, restart BlueZ e cleanup subscription;
- metriche D-Bus e test con transport fake;
- prova fisica iniziale su un solo nodo, senza promuovere il gate 10 nodi.

Advertiser, GATT, autenticazione e sessioni non devono essere mischiati con
questo task.
