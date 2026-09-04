# B0 — Hardware e capability gate

## Attività

- Inventario smartphone/tablet per modello, vendor, Android API, Bluetooth chipset.
- Verifica `BluetoothAdapter.isMultipleAdvertisementSupported()`.
- Verifica `isOffloadedFilteringSupported()` e `isOffloadedScanBatchingSupported()`.
- Verifica apertura GATT server.
- Verifica scan+advertise simultanei.
- Verifica Wi-Fi+BLE coexistence.
- Verifica background/foreground su OEM diversi.

## Classificazione

```text
FULL_NODE: scan + advertise + GATT server/client
CLIENT_ONLY: scan + GATT client
UNSUPPORTED: escluso dal protocollo base
```

Il protocollo peer-to-peer richiede almeno due FULL_NODE nel laboratorio.

## Gate formale

Il gate usa `configs/device-capability-matrix.json` con schema v1. Ogni nodo
formale deve avere esito `PASS` per scan, advertising, GATT client, GATT server,
scan e advertising concorrenti, coesistenza Wi-Fi/BLE e transizione
background/foreground. Campi assenti, sconosciuti o con esito diverso da
`PASS` impediscono la promozione.

I record `SUPPLEMENTAL` e `NON_GATE_EVIDENCE` restano visibili nel report ma
non contribuiscono al minimo di due nodi, che deve includere i ruoli formali
`handheld` e `station`. Il generatore esporta esclusivamente campi pubblici
previsti dall'allowlist; identificatori e riferimenti privati non vengono
serializzati.
