# GATT UUID registry v1

Base: `b1c4a500-7d1f-4f32-9a64-4f4b6c410000`

```text
service       b1c4a500-7d1f-4f32-9a64-4f4b6c410001
hello         b1c4a500-7d1f-4f32-9a64-4f4b6c410002
control_rx    b1c4a500-7d1f-4f32-9a64-4f4b6c410003
control_tx    b1c4a500-7d1f-4f32-9a64-4f4b6c410004
data_rx       b1c4a500-7d1f-4f32-9a64-4f4b6c410005
data_tx       b1c4a500-7d1f-4f32-9a64-4f4b6c410006
ack_tx        b1c4a500-7d1f-4f32-9a64-4f4b6c410007
metrics       b1c4a500-7d1f-4f32-9a64-4f4b6c410008
```

L'advertisement usa il service UUID `...0001` dentro un unico campo AD
`Service Data - 128-bit UUID` (`0x21`). Non deve aggiungere anche la lista
`Complete List of 128-bit Service UUIDs`: sarebbe una duplicazione di 18 byte
e supererebbe il budget legacy.

Nel campo AD, l'UUID e serializzato least-significant-octet first come richiesto
dal formato Bluetooth. Le API Android `ParcelUuid` e BlueZ `ServiceData`
eseguono questa serializzazione; il payload applicativo resta quello definito in
`architecture/DISCOVERY_PROTOCOL.md`.
