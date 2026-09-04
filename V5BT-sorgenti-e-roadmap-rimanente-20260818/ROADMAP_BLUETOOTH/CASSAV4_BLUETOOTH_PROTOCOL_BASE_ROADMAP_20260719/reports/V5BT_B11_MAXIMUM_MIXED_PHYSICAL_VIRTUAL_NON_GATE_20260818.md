# V5BT B11 - Massimo Misto Fisico/Virtuale Non-Gate

Data composizione: `2026-08-18T11:26:26.521Z`  
Schema: `3`  
Harness: `3.0.0`  
Profilo: `mixed-physical`  
Mode: `MAXIMUM_MIXED_PHYSICAL_VIRTUAL_SYSTEM_NON_GATE`  
Evidence class: `MIXED_NON_GATE_EVIDENCE`  
Verdetto: `MIXED_NON_GATE_INCOMPLETE`

## Significato Del Risultato

Il receipt composito non soddisfa il profilo misto. Sono osservati soltanto i
due Palmari richiesti: la Postazione e il Raspberry non risultano osservati
nell'attestazione redatta. La presenza fisica e quindi `2/4` e la readiness
complessiva e `MIXED_PHYSICAL_INCOMPLETE`.

Il risultato non e evidenza ufficiale di gate. `gateImpact` e `NONE`, la
promozione e vietata, B11 resta `PENDING` e l'avanzamento ufficiale resta
`49%`.

## Inventario Richiesto

| Ruolo | Fisici | Virtuali | Totale |
| --- | ---: | ---: | ---: |
| Palmare | 2 | 8 | 10 |
| Postazione | 1 | 2 | 3 |
| Raspberry | 1 | 0 | 1 |
| Cassa automatica | 0 | 1 | 1 |
| Registratore RT | 0 | 1 | 1 |
| **Totale** | **4** | **12** | **16** |

La sostituzione virtuale dei quattro slot fisici non e consentita. Cassa
automatica e registratore RT restano esclusivamente virtuali.

## Presenza E Readiness Correnti

| Controllo | Richiesto | Osservato |
| --- | ---: | ---: |
| Attori fisici | 4 | 2 |
| Palmari | 2 | 2 |
| Postazioni | 1 | 0 |
| Raspberry | 1 | 0 |

La presenza e la readiness runtime non sono complete. La policy firma della
Postazione e `WAIVED_NON_GATE` e la firma non risulta verificata. Nel v3
corrente il waiver e soltanto metadato per una policy futura e non soddisfa
readiness. L'inventario certifica l'APK con SHA-256 byte-esatto e deriva la
copertura signer dallo stesso binding: un signer ignorato lascia l'APK non
certificato e il risultato `INCOMPLETE`. Non viene aggiunta una probe signer
separata.

## Campagna Fisica

| Area | Stato | Completato |
| --- | --- | ---: |
| Cicli radio real-real | `NOT_RUN` | 0/600 |
| Azioni business fisiche | `NOT_RUN` | 0 |
| Comande Palmare fisiche | `NOT_RUN` | 0 |
| Monitor continui | `NOT_RUN` | 0/4 attori |
| Soak fisico wall-clock | `NOT_RUN` | 0 ms |

Non esiste un commitment di campagna fisica. Nessun ciclo o azione simulata e
attribuito agli attori fisici.

## Partizione Della Copertura

| Dominio | Link | Cicli richiesti | Cicli completati attribuiti |
| --- | ---: | ---: | ---: |
| Real-real fisico | 6 | 600 | 0 |
| Cross-domain software | 40 | 4000 | 4000 |
| Virtual-only software | 45 | 4500 | 4500 |
| **Totale logico** | **91** | **9100** | **8500 attribuiti al software** |

La baseline simulata modella 16 attori, 14 nodi Bluetooth e 91 link e completa
9100 cicli. Nel profilo misto soltanto 8500 cicli sono attribuiti al software:
i 600 cicli surrogati degli slot fisici sono esclusi.

Analogamente, la baseline modella 2600 azioni business. Il profilo misto ne
attribuisce 2000 al dominio virtuale ed esclude le 600 azioni surrogate degli
slot fisici.

## Controlli

Sono positivi inventario logico, freschezza e redazione dell'attestazione,
configurazione dei ruoli, registrazione del metadato di policy firma non-gate,
validita della baseline, partizione software, periferiche esclusivamente
virtuali, separazione delle attribuzioni e blocco della promozione. Il check
del metadato policy non equivale a readiness operativa.

Restano negativi presenza fisica completa, readiness runtime, workload radio,
workload business fisico, monitor continui e soak fisico wall-clock. Per
questo il solo verdetto coerente e `MIXED_NON_GATE_INCOMPLETE`.

## Vincolo Del Contratto Eseguibile

Il contratto schema 3 corrente e `MIXED_NON_GATE_INCOMPLETE`-only. Non puo
emettere un verdetto positivo, anche se in input vengono dichiarati 4/4 attori,
600 cicli, 600 azioni, monitor completi o due ore di soak.

Questi valori restano criteri di roadmap per una futura versione del contratto
e dell'harness. Prima di abilitarla devono esistere manifest e receipt fisici
verificabili e legati ai byte sorgente, record per ciascuno dei 6 link e dei 4
attori, timestamp verificabili e provenance esplicita di esecuzione live.

## Integrita

Report JSON sorgente:
`reports/V5BT_B11_MAXIMUM_MIXED_PHYSICAL_VIRTUAL_NON_GATE_20260818.json`.

```text
reportDigest: 79b733a08b0a32cc6bc579bfb94f63d992ec195ad2451b4ab8b4560fd25c79ea
```

Avanzamento roadmap complessiva: **49%**
