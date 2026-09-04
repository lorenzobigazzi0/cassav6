# GATT profile

Service `CASSA_LINK_V1` con caratteristiche:

```text
HELLO          write/read
CONTROL_RX     write / write-without-response
CONTROL_TX     notify/indicate
DATA_RX        write / write-without-response
DATA_TX        notify
ACK_TX         indicate
METRICS        read/notify
```

Gli UUID esatti sono in `configs/gatt-uuids.json`.

## Modello eseguibile B5.2

`shared/protocol/gatt-profile-v1.mjs` e la fonte eseguibile del profilo. Il
modulo verifica che servizio, caratteristiche e flag coincidano esattamente
con `configs/gatt-uuids.json`; non apre connessioni e non contiene stato di
sessione.

Il server Raspberry deriva da questo modello:

```text
GattApplication
  -> CassaGattService
    -> gatt-profile-v1.mjs
```

L'applicazione D-Bus espone una radice ObjectManager, un servizio primario e
sette caratteristiche. Prima del binding a una sessione B5 autenticata, ogni
ReadValue, WriteValue, StartNotify e StopNotify deve fallire con
`org.bluez.Error.NotAuthorized`.

Il profilo non autorizza da solo alcun traffico: autenticazione, chiavi,
sequenze, heartbeat e payload restano responsabilita del livello sessione.
