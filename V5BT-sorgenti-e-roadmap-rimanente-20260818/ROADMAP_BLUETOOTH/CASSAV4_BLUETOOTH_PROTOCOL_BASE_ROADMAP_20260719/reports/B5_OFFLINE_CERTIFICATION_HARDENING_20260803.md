# B5 offline certification hardening

Data: 2026-08-03

## Ambito

Preparazione completa del banco offline per recupero B0-B4, pilot diagnostico
B5.7 e successiva campagna B5 da 100 sessioni. Raspberry e Android erano
disconnessi: nessun ADB, SSH, BlueZ, UPS, deploy o riavvio del servizio
principale e stato eseguito. I risultati locali non promuovono gate fisici.

## Matrice Certificata

`configs/advanced-certification-targets.json` e l'unica fonte per i gate B2,
B3, B4 e il monitor B5.

| Ruolo | Package | Versione | Code | SHA-256 Lab |
| --- | --- | --- | ---: | --- |
| Palmare | `com.sentrapa.palmare.advanced` | `1.0.36` | 37 | `6ba726c47fbcf7fd36cec209249be528330a65b8a14cdd95f6020dcf12dba370` |
| Postazione | `com.sentrapa.postazione.advanced` | `2.0.22` | 24 | `302c4ecd71ec27bf73c2fefc4e9b650c831d0b4341e62a2200bacd95ebc0408f` |

Il caricatore rifiuta campi mancanti/extra, package o versioni non canonici,
digest zero, ruoli duplicati, file assenti e symlink.

## Collector

Il collector B5 e passato a schema v2 e versione `1.1.0`:

- riserva prima della radio un `bootId` CSPRNG `1..255`, diverso dal precedente;
- passa lo stesso valore a runner e advertiser senza esportarlo;
- migra atomicamente soltanto state legacy vuoti;
- rifiuta state legacy con record o transazioni pendenti;
- offre `--preflight` redatto e non mutante;
- recupera journal pre-commit e post-commit senza promozioni implicite;
- rivalida digest, inventario, sequenza e finestre a ogni status/finalize;
- finalizza soltanto `100/100`, con permessi `0600` e no-overwrite.

## Continuita Android

Il monitor ADB `1.0.0` usa un target fisso e una baseline privata. Controlla
continuamente:

- package, versione, code e SHA-256 APK certificati;
- Android user, UID, PID e foreground service;
- timestamp di avvio, sequence e lifecycle dei reporter GATT e Agent;
- HMAC della stessa sessione autenticata, quindi anche logout/account change;
- ApplicationExitInfo per crash Java/native, ANR e reason 10;
- deadline e gap di polling.

L'attestazione esportabile contiene soltanto target tecnico, finestra,
contatori zero e commitment della campagna. Seriali, PID, UID, account, path,
body dei reporter, NodeId ed enrollment restano nei file privati `0600`.

## Gate B5

Il gate `1.1.0` richiede quattro file distinti: manifest, state collector,
attestazione Android e output nuovo. Verifica indipendentemente:

- state schema v2 con 100 record ordered e commitment corretto;
- corrispondenza di ogni digest e metadato state-report;
- stesso `sha256(campaignRunId)` nell'attestazione;
- copertura monitor dal primo capture start all'ultimo report;
- process/session/crash continuity e tutti i contatori monitor a zero;
- report fisici unici, non sovrapposti, completi e leak-free.

L'aggregate non include UUID, commitment, record ID, report hash, seriali,
path o dettagli per sessione. Il self-test resta sempre `PENDING`.

## Manifest Ed Evidenze Esterne

`MANIFEST.txt` viene rigenerato dall'inventario reale. Il validatore confronta
package e manifest in entrambe le direzioni e rifiuta symlink, elementi non
canonici o file non dichiarati.

Sei evidenze storiche assenti sono elencate in
`configs/external-evidence-status.json` come `UNAVAILABLE` e
`mustNotBeSynthesized=true`. Non vengono ricostruite. Il pacchetto sorgente
puo essere coerente, ma la promozione roadmap resta bloccata da tali evidenze
esterne e dai gate fisici pendenti.

## Verifiche Riprodotte

```text
Suite Raspberry + TypeScript:     156/156 PASS
Contratti JSON/protocollo:         17/17 PASS
Advertiser Python:                   7/7 PASS
Matrice certificazione:              3/3 PASS
B2 harness ADB:                     17/17 PASS
B2 self-test reciproco:             53/53 PASS
B3 gate:                            28/28 PASS
B3 self-test:                       41/41 PASS
Monitor Android:                    17/17 PASS
Collector B5:                       26/26 PASS
Gate B5:                            28/28 PASS
Inventario manifest:                 4/4 PASS
Isolamento workspace:               13/13 PASS
Archivio sorgente:                    3/3 PASS
Errori di isolamento package:            0
```

I due test B4 che richiedono il log fisico storico assente restano evidenza
esterna mancante e non sono stati falsificati con fixture sostitutive.

## Stato E Ripresa

```text
Avanzamento roadmap: 49%
B4:                  1/10 storico, da rivalidare
Pilot B5.7:          PENDING
Campagna B5:         PENDING
B6:                  PENDING
```

Il pilot e consentito dopo PASS B0-B3 e rivalidazione del ledger B4 parziale,
ma usa state separato e non conta. La campagna ufficiale inizia soltanto dopo
PASS B0-B4, termina con revisione indipendente e viene seguita dal ripristino
conservativo delle build normali senza riavviare `cassav5bt.service`.
