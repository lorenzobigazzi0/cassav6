# MQTT command pilot - Step 17

Step 17 introduce il primo adattatore comandi MQTT, ancora default-off e non
collegato al runtime principale.

Il pilot serve a validare il percorso:

```text
MQTT command envelope -> command_inbox -> handler pilot -> ACK MQTT
```

senza rendere MQTT una sorgente autoritativa alternativa.

## Confini

- Comandi MQTT spenti finche' il gate Step 15 non e' aperto.
- Unico comando pilotato: `notifications.ack`.
- Nessun comando ordine, pagamento, fiscale o stampa viene eseguito via MQTT.
- L'ACK viene pubblicato come evento MQTT su:

```text
pos/{storeId}/events/commands/{deviceId}/{requestId}
```

Questo mantiene l'ACK nel perimetro fanout `events/#` gia' previsto dal broker.

## Envelope richiesto

```json
{
  "requestId": "req-001",
  "idempotencyKey": "device-1:ack-1",
  "deviceId": "device-1",
  "userId": "lorenzo",
  "commandType": "notifications.ack",
  "payload": {
    "id": "ntf-1",
    "action": "ack",
    "consumer": "mobile-frontend"
  }
}
```

Per `notifications.ack` l'aggregate viene normalizzato in:

```json
{
  "aggregateType": "notification",
  "aggregateId": "ntf-1"
}
```

## Semantica idempotenza

| Stato command_inbox | Comportamento MQTT |
|---|---|
| `created` | esegue handler pilot e salva `committed` / `rejected` / `failed` |
| `committed` | non riesegue handler, pubblica ACK replay |
| `processing` | non riesegue handler, pubblica ACK `processing` recoverable |
| `conflict` | pubblica ACK `rejected` con `COMMAND_PAYLOAD_CONFLICT` |
| comando non supportato | passa da inbox e viene memoizzato `rejected` |
| payload invalido ma envelope riconoscibile | non tocca inbox, pubblica ACK `rejected` |

## ACK

Esempio:

```json
{
  "transport": "mqtt",
  "requestId": "req-001",
  "idempotencyKey": "device-1:ack-1",
  "deviceId": "device-1",
  "commandType": "notifications.ack",
  "aggregateType": "notification",
  "aggregateId": "ntf-1",
  "status": "committed",
  "ok": true,
  "replayed": false,
  "recoverable": false,
  "result": {
    "ok": true,
    "acknowledged": true
  }
}
```

## Check

```bash
npm run test:phase17
npm run test:phase15
npm run check:backend
```

## Rollback

Nessuna variabile nuova. Il rollback resta:

```env
MQTT_COMMANDS_ENABLED=0
MQTT_COMMAND_ACK_ENABLED=0
```

Il modulo `backend/modules/realtime-backbone/mqtt-command-pilot.js` puo'
restare nel codice: se il gate e' chiuso, non sottoscrive topic e non processa
comandi.
