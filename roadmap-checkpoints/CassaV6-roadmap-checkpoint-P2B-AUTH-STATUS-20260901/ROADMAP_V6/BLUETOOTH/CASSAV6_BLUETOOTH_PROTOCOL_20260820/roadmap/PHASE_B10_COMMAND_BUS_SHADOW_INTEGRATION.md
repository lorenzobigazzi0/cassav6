# B10 - Command bus shadow integration

## Stato

Bus diagnostico, adapter shadow e router hanno verdetto software
`PASS_OFFLINE` su Node e nelle due matrici Android full `340/340 PASS`.
L'integrazione resta disabilitata per default e non autorizza traffico
business BLE.

## Contratto Shadow

Il comportamento obbligatorio e:

```text
GUI e comandi business continuano a usare LAN HTTP/SSE
agent riceve soltanto HEALTH/PING/TEST diagnostici
BLE trasporta una copia shadow, se esplicitamente abilitata in Lab
metriche confrontano il percorso LAN e quello diagnostico BLE
nessun comando business viene deviato, accodato o inoltrato su BLE
```

`BluetoothDiagnosticCommandBusV1` valida tipo e dimensioni prima della
consegna ai subscriber. Il service produce `HEALTH`; `PING` e `TEST` usano lo
stesso contratto. L'adapter assegna correlazione e timestamp, invia sul canale
affidabile e l'ingress sopprime i duplicati.

Il router rifiuta un frame `DATA` come `BUSINESS_MESSAGE_FORBIDDEN`. Snapshot
e risultati dichiarano sempre:

```text
businessMessagesForwarded=0
businessTransport=LAN_HTTP_SSE
```

## Feature Flag

Tutti i flag normali sono OFF. In particolare:

```text
BLUETOOTH_FAILOVER_ENABLED=0
BLUETOOTH_ROUTE_ADVERTISEMENT_ENABLED=0
BLUETOOTH_COMMAND_BUS_SHADOW=0
```

Shadow richiede route advertisement e una porta affidabile autenticata. Se
uno dei prerequisiti manca, il runtime resta `BLOCKED`; non usa HTTP come
fallback radio e non cambia il percorso business.

## Verifica

Le suite coprono subscribe/unsubscribe, limiti subscriber, validazione,
producer HEALTH, emissione `HEALTH/PING/TEST`, duplicato, handler fallito,
route prerequisita, frame business rifiutato e cleanup. B11 esercita tre tipi
diagnostici e i relativi duplicati.

Un run fisico dovra confrontare metriche LAN/BLE senza produrre effetti
business. Fino a quel run B10 resta software non-gate e l'avanzamento
ufficiale resta 49%.
