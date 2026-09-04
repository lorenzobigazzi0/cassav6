# B3 — Agent Android

## Obiettivo e stato

Implementare `BluetoothFailoverService` come foreground service nativo e
stabilizzare il lifecycle Android del discovery B2 senza aprire ancora
sessioni BLE.

```text
Implementazione locale: PASS
Gate foreground-service fisico 60 minuti: PENDING
```

Il gate fisico resta separato dall'implementazione locale. Richiede due
Advanced Lab reali osservati per esattamente 3600 secondi e una successiva
revisione dell'evidenza.

## Scope implementato

```text
BluetoothFailoverService
BluetoothPermissionCoordinator
BleScanner e BleAdvertiser B2
BluetoothPeerDirectory B2
BluetoothConnectivityStateMachine
BluetoothConnectivityMetrics
BluetoothAgentStateStore
BluetoothAgentLabReporter
BluetoothFailoverUiBridge read-only
```

`GattServer`, `GattClient` e `SessionManager` restano componenti delle fasi
B5/B6. In B3 non vengono aperte risorse GATT, non esistono sessioni dirette e
non viene trasportato alcun messaggio business, health o test.

## Feature gate fail-closed

Il master `cassaBluetoothFailover` e `false` per default. La build rende
`BLUETOOTH_FAILOVER_ENABLED=true` soltanto quando sono veri anche:

```text
cassaBluetoothLab
cassaBluetoothIdentity
cassaBluetoothDiscovery
```

Le build standard mantengono quindi l'agent non avviabile. L'assenza di uno
dei prerequisiti lascia lo stato `DISABLED` e non costruisce il coordinator
radio.

I flag futuri restano entrambi `false`:

```text
cassaBluetoothDirectServer
cassaBluetoothPeerLink
```

Se uno di essi viene richiesto durante B3, la policy abilita il service solo
per registrare il fault, blocca la discovery e porta il lifecycle in
`DEGRADED`. Non viene creato un GATT server/client e nessuna sessione viene
aperta. Anche gli eventi futuri della macchina a stati sono guarded per
default.

## Lifecycle deterministico

Stati dichiarati:

```text
DISABLED
PERMISSION_REQUIRED
STARTING
DISCOVERING
DIRECT_SERVER
PEER_CONNECTED
DEGRADED
BACKOFF
STOPPED
```

In B3 il percorso operativo termina a `DISCOVERING`; `DIRECT_SERVER` e
`PEER_CONNECTED` sono soltanto valori riservati e non raggiungibili con la
guardia predefinita. Eventi duplicati non cambiano stato o sequence. Eventi
illegali e futuri falliscono senza mutare lo stato e incrementano solo
contatori aggregati.

Il permission coordinator tratta
`BLUETOOTH_SCAN`, `BLUETOOTH_ADVERTISE` e `BLUETOOTH_CONNECT` come insieme
obbligatorio da Android 12. Permessi mancanti portano a
`PERMISSION_REQUIRED`; fault radio e retry producono `DEGRADED`/`BACKOFF`;
chiusura e feature disable sono deterministici.

Le metriche B3 contengono soltanto:

```text
start
stop
backoff
transition
duplicate event
invalid/future-guarded transition
```

## Ordine foreground service e radio

Il servizio entra prima in foreground con il tipo base `dataSync`. Solo dopo
che tutti i prerequisiti B2 sono `READY`, il coordinator richiede
`connectedDevice`. Scanner e advertiser possono partire soltanto se
l'aggiornamento del tipo FGS e stato accettato.

```text
prerequisiti READY
  -> FGS connectedDevice accettato
  -> advertiser/scanner avviati
```

Se l'aggiornamento FGS fallisce, il coordinator arresta la radio, entra in
backoff e ritenta. Revoca permessi, adapter non pronto, identity non `READY` o
stop del servizio arrestano scanner/advertiser, svuotano lo stato anonimo e
rimuovono l'eleggibilita `connectedDevice`.

## Stato redatto e UI

Il reporter Lab scrive atomicamente un contratto aggregato separato:

```text
no_backup/bluetooth-connectivity-agent-status-v1.json
```

Questo file non e il reporter discovery B2. Espone soltanto stato lifecycle,
metriche aggregate e booleani per scanner, advertiser, GATT e numero
sessioni. Per B3 i campi GATT sono sempre `false` e `sessionCount` e sempre
zero. Seriali, NodeId, alias, MAC/indirizzi BLE, token, chiavi, certificati e
materiale di enrollment sono vietati.

La WebView e diagnostic-only e read-only. Con
`cassaBluetoothDiagnosticBadge=true` puo leggere o ricevere esclusivamente:

```json
{
  "schemaVersion": 1,
  "source": "V6_ANDROID_CONNECTIVITY_AGENT",
  "sequence": 0,
  "state": "DISABLED"
}
```

Il bridge non accetta comandi, peer, messaggi o mutazioni del servizio. Un
eventuale collegamento al command bus resta fuori scope e richiedera una fase
successiva.

## Evidenza locale

Le verifiche locali coprono:

- matrice di transizione, eventi illegali e guardie future;
- idempotenza e nessun churn su 3600 tick deterministici;
- contatori lifecycle aggregati;
- JSON WebView con esattamente quattro campi;
- listener store thread-safe, unsubscribe idempotente e massimo 32 listener;
- schema Lab redatto con GATT e sessioni inattivi;
- policy dei flag futuri e dei tre permessi Android;
- build e test unitari di entrambe le app Advanced.

Questa evidenza chiude l'incremento software locale ma non il gate fisico.
Conteggi finali, build Lab e audit sono consolidati in
`reports/B3_ANDROID_CONNECTIVITY_AGENT_20260720.md`.

## Gate fisico 60 minuti

Il runner e descritto in `testing/B3_ANDROID_SERVICE_GATE.md`. Il gate richiede
due target Advanced Lab certificati e una misura non abbreviabile di 3600
secondi. Deve osservare un reporter unico e monotono, nessun silenzio di 30
secondi, un solo start, zero stop/invalid transition, nessuno stato
`STOPPED`/`DIRECT_SERVER`/`PEER_CONNECTED`, zero risorse GATT e zero sessioni.
Package, versione e SHA-256 dei due APK sono caricati dalla baseline condivisa
`configs/advanced-certification-targets.json` e verificati prima del timer.

Al 2026-07-20 il gate resta `PENDING`: `adb devices -l` non elenca dispositivi
e quindi il soak non e iniziato. Il Raspberry Lab `192.168.1.79` resta senza
route, ma il runner B3 non lo contatta e non usa questa condizione come prova
sostitutiva.

## Isolamento V4 e rollback

B3 modifica soltanto la copia V6. Non installa APK, non riavvia V4, non
modifica server o database e non espone endpoint. Il sistema V4 attivo resta
intatto.

Il rollback consiste nel mantenere `cassaBluetoothFailover=false`, valore
standard predefinito. In questo stato il service non viene avviato e non
esistono operazioni radio B3.
