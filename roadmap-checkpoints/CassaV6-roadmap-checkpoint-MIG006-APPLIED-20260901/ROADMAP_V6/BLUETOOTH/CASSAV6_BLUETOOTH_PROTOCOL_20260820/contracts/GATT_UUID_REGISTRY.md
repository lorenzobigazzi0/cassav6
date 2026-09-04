# GATT UUID registry v1

Catalogo deterministico UUIDv5 Cassa V6:

```text
service       3c9734f1-46cb-5672-96e9-e7a03a710f95
hello         34f16f91-8558-595d-ba61-f0b31b2aa7f0
control_rx    6c4927da-180d-5e9a-a3c7-c3b7cbccc499
control_tx    d9af61c0-289d-583d-877c-ef19a49413c9
data_rx       520f34b8-8e37-50a7-ada0-00252a94f11c
data_tx       13e8dde6-a0d5-5227-9608-5a71a65de87a
ack_tx        5ea76dec-cbaa-5aee-9156-6058066a3a7a
metrics       544e9ea6-c9a9-56f7-a1ed-41afe8c72078
```

L'advertisement usa il service UUID
`3c9734f1-46cb-5672-96e9-e7a03a710f95` dentro un unico campo AD
`Service Data - 128-bit UUID` (`0x21`). Non deve aggiungere anche la lista
`Complete List of 128-bit Service UUIDs`: sarebbe una duplicazione di 18 byte
e supererebbe il budget legacy.

Nel campo AD, l'UUID e serializzato least-significant-octet first come richiesto
dal formato Bluetooth. Le API Android `ParcelUuid` e BlueZ `ServiceData`
eseguono questa serializzazione; il payload applicativo resta quello definito in
`architecture/DISCOVERY_PROTOCOL.md`.
