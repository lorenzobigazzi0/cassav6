# Scope e non-obiettivi

## Incluso

- BLE legacy advertising compatibile col maggior numero di Android.
- BLE scanning adattivo.
- Android peripheral/GATT server capability gate.
- Android central/GATT client.
- Raspberry BlueZ advertising/scanning/GATT server.
- Autenticazione applicativa reciproca.
- Frammentazione GATT.
- ACK/retry/deduplica.
- Outbox/inbox minima.
- Telemetria e badge.
- Profilo B11 applicativo interamente virtualizzato con cassa automatica e RT
  mock, esclusivamente come evidenza software NON-GATE.

## Non incluso

- Multi-hop attivo.
- Bridge tra peer.
- Load balancing.
- Serverless operation log.
- Gateway ESP32.
- Nearby/Wi-Fi Direct data plane.
- Pagamenti/fiscale offline.
- Qualunque uso del profilo virtuale come sostituto di hardware, radio o
  periferiche fisiche nei gate formali.
