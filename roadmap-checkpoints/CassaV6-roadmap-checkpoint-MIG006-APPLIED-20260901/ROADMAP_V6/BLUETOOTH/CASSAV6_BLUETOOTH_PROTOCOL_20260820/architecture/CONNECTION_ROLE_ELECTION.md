# Connection role election

## Android ↔ Raspberry

Android connette, Raspberry serve.

## Android ↔ Android

1. verificare capability;
2. confrontare rotating alias corrente;
3. alias minore = GATT server;
4. alias maggiore = dialer/client;
5. se entrambe le connessioni esistono, mantenere quella col sessionId deterministico minore.
