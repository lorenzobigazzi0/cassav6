# B1 — Protocollo, identità e provisioning

## Deliverable

- UUID registry v1.
- NodeId stabile non trasmesso in chiaro negli advertisement.
- rotatingNodeAlias per discovery.
- chiave privata in Android Keystore.
- device certificate/registry sul Raspberry.
- QR/one-time enrollment per laboratorio.
- protocolVersion e capability bitmap.

## Sicurezza

Advertisement non contiene nome utente, tavolo, ordine, store name o dati personali.

## Contratto wire v1

Il formato advertising e congelato a 10 byte di Service Data dentro un AdvData
legacy completo da 31 byte. AdvData e il campo Advertising Data, non l'intera
PDU Link Layer. Il service UUID non viene duplicato in una lista UUID separata:

```text
Flags 3 + Service Data 128 overhead 18 + payload 10 = 31 byte
```

L'encoder di riferimento emette Flags-first. Il decoder interoperabile accetta
anche l'ordine Service Data-first osservato su BlueZ, ma sempre con esattamente
una struttura di ciascun tipo, senza duplicati, campi extra o byte residui.

La motivazione, i bit assegnati e l'algoritmo rotatingNodeAlias sono in
`architecture/DISCOVERY_PROTOCOL.md`. Il codec di riferimento e i vettori
eseguibili sono in `shared/protocol/` e
`contracts/PROTOCOL_TEST_VECTORS.json`.

## Vincoli di provisioning

- NodeId: UUID stabile generato una sola volta.
- aliasKey: 32 byte casuali, mai esportati nei log o negli advertisement.
- bootId: casuale nell'intervallo 1..255 a ogni avvio.
- enrollment token: almeno 128 bit casuali, monouso e con scadenza.
- il registry lega NodeId, chiave pubblica del device, aliasKey e stato di revoca.
- il QR di laboratorio contiene solo il token monouso e l'identificatore del
  punto di enrollment, non chiavi private.

## Gate

```bash
node --test shared/protocol/advertisement-v1.test.mjs
node shared/provisioning/device-registry-v1.test.mjs
node --test shared/provisioning/device-registry-v1.test.mjs
node scripts/validate-contracts.mjs --root .
```

Il gate verifica codec, alias HMAC, UUID on-air, i due ordini strutturali
ammessi, rifiuto di duplicati/extra, bit riservati e budget completo da 31 byte.
Il test registry verifica inoltre enrollment valido, scadenza, replay
concorrente, chiavi non Ed25519/private, permessi `0600`, redazione, assenza di
chiavi private Android, ownership del lock, recovery `.pending` idempotente,
distinzione `COMMITTED`/`NOT_COMMITTED`/`UNCERTAIN` e rifiuto di token file
sensibili non canonici.

Il superamento locale non chiude B1: restano fault injection con power loss
sul filesystem Raspberry e verifica dell'enrollment/Keystore sui device
Android fisici.

## Stato runtime

L'implementazione shared/Raspberry e solo libreria piu CLI amministrativa
offline. `CASSA_BT_FEATURE_ENABLED=0` e
`CASSA_BT_ENROLLMENT_RUNTIME_ENABLED=0` restano i valori predefiniti. Nessun
processo radio o flusso business usa il registry in questa fase.
