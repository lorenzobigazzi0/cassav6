# MQTT command gate - Step 15

Step 15 prepara il confine per eventuali comandi MQTT futuri senza abilitarli
operativamente.

MQTT resta fanout realtime da `event_outbox`. Un payload client ricevuto via
broker non diventa mai autoritativo senza passare da `command_inbox`, commit
relazionale/MySQL e ACK applicativo.

## Flag

```env
MQTT_COMMANDS_ENABLED=0
COMMAND_INBOX_ENABLED=1
COMMAND_INBOX_MODE=shadow
MQTT_COMMAND_ACK_ENABLED=0
```

`MQTT_COMMANDS_ENABLED=1` e' solo una richiesta. L'effettiva abilitazione
runtime richiede contemporaneamente:

- `COMMAND_INBOX_ENABLED=1`;
- `COMMAND_INBOX_MODE=write|enforce|enforce_pilot`;
- `MQTT_COMMAND_ACK_ENABLED=1`.

Se uno di questi prerequisiti manca, `normalizeMqttBridgeConfig()` espone:

```js
{
  commandsRequested: true,
  commandsEnabled: false,
  commandGate: {
    reasons: ["..."]
  }
}
```

## Motivo

I comandi MQTT richiedono almeno:

- `requestId`;
- `idempotencyKey`;
- `deviceId`;
- `commandType`;
- payload canonico;
- ACK/replay persistito.

Questo e' il contratto gia' definito in `docs/command-envelope-contract.md`.
Step 15 impedisce che un semplice flag trasformi MQTT in una scorciatoia attorno
a `command_inbox`.

## Check

```bash
npm run check:mqtt-command-gate:report
npm run test:phase15
npm run test:phase17
npm run test:phase14i
npm run check:backend
```

Il report viene scritto in:

```text
reports/mqtt-command-gate-check.json
reports/mqtt-command-gate-check.md
```

## Rollback

```env
MQTT_COMMANDS_ENABLED=0
MQTT_COMMAND_ACK_ENABLED=0
```

Il rollback non tocca il bridge eventi MQTT, SSE, `event_outbox` o
`command_inbox`.

## Step 17

`docs/mqtt-command-pilot-step17.md` aggiunge il primo adattatore pilot per
`notifications.ack`, ancora non collegato al runtime principale. Il gate Step
15 resta il confine operativo: senza command-inbox enforce/write e
`MQTT_COMMAND_ACK_ENABLED=1` il pilot non processa comandi.
