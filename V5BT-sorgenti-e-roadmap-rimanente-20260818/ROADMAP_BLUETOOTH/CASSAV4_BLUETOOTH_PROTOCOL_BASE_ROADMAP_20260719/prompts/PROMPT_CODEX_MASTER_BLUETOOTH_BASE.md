# Prompt Codex — implementazione base Bluetooth CASSAv4

Agisci come senior Android connectivity engineer, Bluetooth Low Energy engineer e Raspberry/BlueZ engineer.

## Obiettivo

Implementare la prima base del protocollo Bluetooth CASSAv4, senza ESP32 e senza routing multi-hop attivo.

Il risultato deve permettere:

```text
Raspberry vede automaticamente palmari/tablet autorizzati
Android vede automaticamente Raspberry
Android vede automaticamente altri Android
Android ↔ Raspberry apre sessione BLE GATT sicura
Android ↔ Android apre sessione BLE GATT sicura
scambio heartbeat, capability, ACK e messaggi di test
persistenza minima outbox/inbox
telemetria e stato UI
```

## Vincoli

- Non implementare ESP32.
- Non implementare ancora forwarding multi-hop business.
- Non implementare pagamenti offline o fiscale.
- Non cambiare la logica business del POS.
- Non affidarsi al pairing Bluetooth come unica sicurezza.
- Non includere dati business sensibili negli advertisement.
- Non usare scan continuo senza finestre/backoff.
- Non mostrare “server committed” prima dell'ACK server.

## Ordine di lavoro

1. Leggi `roadmap/MASTER_ROADMAP.md`.
2. Esegui capability gate su tutti i modelli Android reali.
3. Fissa UUID e contratti v1.
4. Implementa identity/provisioning.
5. Implementa discovery BLE Android.
6. Implementa nodo BlueZ Raspberry.
7. Implementa sessione diretta Android↔Raspberry.
8. Implementa sessione diretta Android↔Android con role election deterministica.
9. Implementa frame codec, fragment/reassembly, ACK, retry e deduplica.
10. Implementa Room/SQLite outbox/inbox minima.
11. Integra il command bus in shadow mode solo con ping/echo/health.
12. Esegui test e gate B11.

## Output richiesto

- file implementati/modificati;
- test eseguiti;
- modelli Android certificati/non certificati;
- risultati discovery/connect/throughput/reconnect;
- finding e rischi;
- go/no-go per iniziare multi-hop.
