# B4.2 Raspberry BlueZ D-Bus Adapter

Data: 2026-07-20

## Decisione al termine di B4.2

- Incremento B4.2 scanner D-Bus: PASS
- Smoke lifecycle BlueZ ARM64: PASS
- Recovery dopo restart reale BlueZ: PASS
- Callback ServiceData da advertiser V1 fisico: PENDING
- Gate B4 con almeno 10 peer reali consecutivi: PENDING

Il binding live e utilizzabile, ma il gate B4 non viene promosso. Durante le
prove non era presente un advertiser V1 e quindi i 10 peer del test automatico
restano una simulazione deterministica, non evidenza radio.

Aggiornamento B4.3: la callback ServiceData da un Palmare fisico e ora `PASS`.
Il gate con 10 dispositivi fisici distinti resta `PENDING`. L'evidenza e in
`reports/B4_3_RASPBERRY_PHYSICAL_SERVICEDATA_20260720.md`.

## Scope

Sono stati implementati soltanto scanner e lifecycle D-Bus:

- `BluezDbusPort`: contratto infrastrutturale e decoder puro;
- `DbusNextBluezPort`: system bus, `ObjectManager`, `Adapter1` e segnali;
- `BluezAdapter`: cache per-device, filtro UUID e recovery;
- test adapter/transport con dipendenze fake;
- template systemd V5BT fail-closed.

Advertiser, GATT server, autenticazione, sessioni dirette, backend bridge e
business logic POS restano fuori da B4.2.

## Contratto BlueZ

Il port risolve esattamente:

```text
/org/bluez/hci0
org.bluez.Adapter1
```

Durante B4.2, prima di acquisire la sessione verificava `Powered=true` e
applicava:

```text
UUIDs         = [UUID servizio v1]
Transport     = le
DuplicateData = true
```

Una sola subscription D-Bus riceve:

```text
InterfacesAdded
InterfacesRemoved
PropertiesChanged
NameOwnerChanged per org.bluez
```

RSSI e ServiceData vengono validati e copiati prima dell'uso. Il filtro UUID
viene ripetuto localmente perche BlueZ unisce i filtri discovery dei client.
Object path, indirizzi Bluetooth e payload non entrano in log o metriche.

La prova fisica B4.3 ha mostrato che BlueZ 5.82 non consegna in modo
affidabile gli advertisement Android con UUID presente soltanto nella mappa
`ServiceData` quando il filtro BlueZ contiene `UUIDs`. Il filtro effettivo e
stato quindi corretto in:

```text
Transport     = le
DuplicateData = true
```

Il filtro UUID locale in `BluezAdapter` resta autorevole e impedisce a
ServiceData estranei di entrare nel registry.

## Recovery

La perdita dell'owner `org.bluez`:

1. invalida la sessione discovery;
2. svuota la cache per-device;
3. lascia il processo e il registry attivi;
4. attende il nuovo owner;
5. ripete risoluzione, filtro e `StartDiscovery`;
6. usa backoff deterministico limitato a 5 secondi in caso di finestra
   transitoria non pronta.

Lo stop cancella ogni retry, chiama `StopDiscovery`, rimuove le match rule e
disconnette il bus. I segnali `NameOwnerChanged` relativi ad altri client
D-Bus vengono ignorati; un primo smoke li aveva erroneamente conteggiati come
due errori e il caso e ora coperto da regressione.

## Dipendenza

Il pacchetto originale `dbus-next@0.10.2` e stato valutato e scartato perche
il suo audit portava 10 vulnerabilita transitive. La versione fissata e:

```text
@jellybrick/dbus-next@0.11.1
```

L'installazione bloccata da `package-lock.json` riporta zero vulnerabilita.
`skipLibCheck` e attivo soltanto per una incoerenza nei `.d.ts` pubblicati dal
pacchetto; `strict` e `noEmitOnError` restano attivi sul codice V5BT.

## Validazione locale

```text
npm run check: PASS
npm test: 14/14 PASS
npm audit --omit=dev: 0 vulnerabilita
shared protocol/discovery: 50/50 PASS
validate-contracts: PASS, 15 contratti
validate-roadmap-package: PASS
```

La suite registry durabile non e certificabile su Windows perche il
filesystem non supporta il `fsync` della directory usato dal test. Il codice
fallisce chiuso con `REGISTRY_DURABILITY_UNCERTAIN`; la stessa suite sul
Raspberry Linux passa.

## Validazione Raspberry

Target:

```text
host: 192.168.0.67
architettura: aarch64
Node.js: 24.15.0
BlueZ: 5.82
```

Suite:

```text
nodo B4.2: 14/14 PASS
registry B1: 20/20 PASS
enrollment transport B1: 12/12 PASS
npm audit --omit=dev: 0 vulnerabilita
smoke come utente cassav5bt: PASS
```

Smoke start/stop:

```text
prima:  Powered=yes, Discovering=no,  ActiveInstances=0
durante: Powered=yes, Discovering=yes, ActiveInstances=0
dopo:   Powered=yes, Discovering=no,  ActiveInstances=0
```

Snapshot finale:

```text
StartDiscovery calls: 1
StopDiscovery calls: 1
active match rules: 0
D-Bus port errors: 0
observation handler errors: 0
```

Lo stesso start/stop e stato ripetuto come utente isolato `cassav5bt`, dalla
struttura leggibile che replica il futuro deploy `/opt`. `StartDiscovery` e
`StopDiscovery` sono autorizzati via D-Bus anche senza aggiungere l'utente al
gruppo `bluetooth`; lo snapshot finale riporta zero errori e zero match rule.

Smoke restart reale:

```text
bluetooth.service restart: PASS
owner changes osservati: 2
reconnect attempts: 2
reconnect successes: 1
StartDiscovery calls: 2
StopDiscovery calls: 1
stato finale: Discovering=no, ActiveInstances=0
```

Il primo tentativo di reconnect e avvenuto mentre BlueZ stava ancora
ricreando l'adapter; il retry successivo ha recuperato autonomamente. Il port
D-Bus non ha registrato errori di protocollo.

## Isolamento e rollback

Nessuna unit del nodo scanner e stata installata o abilitata. Il template
legacy V4 presente nel pacchetto e stato sostituito con
`cassav5bt-bluetooth-node.service`, che usa percorsi V5BT e mantiene:

```text
CASSA_BT_FEATURE_ENABLED=0
CASSA_BT_DRY_RUN=1
```

Il backup remoto pre-B4.2 e:

```text
/home/admin/cassav5bt-backups/B4_2_20260720-1209/raspberry-b4.1
```

Il rollback consiste nel mantenere la feature disabilitata e ripristinare
quella directory. Non sono state introdotte migrazioni dati o stato radio
persistente. V4 non e stato modificato.

## Esito del task successivo

B4.3 e stato eseguito separatamente:

1. un Palmare V1 fisico controllato: PASS;
2. callback `Device1.ServiceData` end-to-end: PASS;
3. osservazioni, RSSI, pruning e cleanup: PASS;
4. 10 dispositivi fisici distinti consecutivi: PENDING.

Il prossimo task e il punto 4. Advertising Raspberry, GATT e sessioni restano
task distinti.
