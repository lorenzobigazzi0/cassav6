# Command envelope contract

Ogni azione critica del POS deve convergere verso questo envelope.

```json
{
  "requestId": "req_01J...",
  "idempotencyKey": "device-03:seq-184",
  "deviceId": "device-03",
  "userId": "waiter-7",
  "stationId": "station-main",
  "commandType": "orders.create",
  "aggregateType": "order",
  "aggregateId": "ord_123",
  "expectedVersion": 12,
  "createdAt": "2026-07-06T10:00:00.000Z",
  "payload": {}
}
```

## Campi obbligatori

- `requestId`
- `idempotencyKey`
- `deviceId`
- `commandType`
- `payload`

## Campi raccomandati

- `userId`
- `stationId`
- `aggregateType`
- `aggregateId`
- `expectedVersion`

## Risposta standard

```json
{
  "requestId": "req_01J...",
  "status": "committed",
  "aggregateType": "order",
  "aggregateId": "ord_123",
  "aggregateVersion": 13,
  "events": [1840, 1841]
}
```

Oppure:

```json
{
  "requestId": "req_01J...",
  "status": "rejected",
  "errorCode": "ORDER_ALREADY_PAID",
  "recoverable": false
}
```

## Semantica retry

| Caso | Risposta |
|---|---|
| Primo comando | `created`, poi handler |
| Stesso comando già committed | replay risultato |
| Stesso comando ancora processing | `processing` / attendere o polling ack |
| Stessa key, payload diverso | `conflict` |
| Comando rigettato business | replay rejected |

## Uso con MQTT futuro

Per MQTT commands il client pubblica una richiesta su topic `commands/*`, ma il backend deve prima passare da `command_inbox` e solo dopo pubblicare ACK/eventi.

MQTT non deve mai rendere autoritativo un payload client senza commit MySQL.
