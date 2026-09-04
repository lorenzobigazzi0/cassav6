# Master roadmap — Bluetooth base

## Obiettivo finale di questo primo incremento

Al termine di B11 deve esistere un cluster locale di nodi Bluetooth nel quale tutti i nodi autorizzati vengono scoperti automaticamente e possono aprire collegamenti diretti affidabili.

```text
                    BLE discovery
      ┌──────────────────────────────────┐
      │                                  │
Android phone A  ←──────────────→ Android tablet B
      │                                  │
      └──────────────→ Raspberry ←───────┘
                       BlueZ node
```

Il Raspberry resta l'autorità. Il peer-to-peer Android è preparato per il successivo routing multi-hop, ma in questa fase trasporta solo control/health/test messages e non inoltra comandi business per altri nodi.

## Deliverable per milestone

| Milestone | Deliverable |
|---|---|
| M0 | device capability matrix |
| M1 | protocol/UUID/schema frozen v1 |
| M2 | Android discovery service |
| M3 | Raspberry BlueZ discovery/GATT node |
| M4 | direct Android↔Raspberry session |
| M5 | direct Android↔Android session |
| M6 | reliable framed channel + durability |
| M7 | route/server reachability advertisements |
| M8 | command bus shadow adapter |
| M9 | test lab/pilot gate |

## M9 - Profilo Massimo Misto

Il test massimo e lo schema 3
`MAXIMUM_MIXED_PHYSICAL_VIRTUAL_SYSTEM_NON_GATE`: 10 Palmari, dei quali 2
fisici e 8 virtuali; 3 Postazioni, delle quali 1 fisica e 2 virtuali; 1
Raspberry fisico; cassa automatica e RT virtuali. Sono 16 attori, 4 fisici e
12 virtuali. Cassa automatica e RT restano sul piano applicativo LAN e non
diventano nodi Bluetooth.

I 91 link logici sono separati in 6 real-real, 40 cross-domain e 45
virtual-only. Il modello software copre `4000/4000` cicli cross-domain e
`4500/4500` virtual-only; i `600` cicli real-real e le `600` azioni dei target
fisici non possono essere sostituiti dai surrogati software.

Il risultato corrente e `MIXED_NON_GATE_INCOMPLETE`: `2/4` attori fisici
osservati, cioe i 2 Palmari; Postazione e Raspberry risultano `0/1`;
radio, business fisico, monitor e soak sono `NOT_RUN`. Il contratto eseguibile
schema 3 e `MIXED_NON_GATE_INCOMPLETE`-only e non puo produrre un PASS.

`WAIVED_NON_GATE` e solo metadato per una policy futura, non readiness. Poiche
l'inventario certifica l'APK con SHA-256 byte-esatto e deriva la copertura
signer dallo stesso binding, un signer ignorato lascia l'APK non certificato e
il profilo `INCOMPLETE`. Il v3 non aggiunge una probe signer separata.

I target 4/4, `600/600` cicli fisici, `600/600` azioni incluse 160 comande,
monitor 4/4 e soak wall-clock di almeno due ore restano criteri per una futura
versione del contratto/harness. Tale versione non puo essere abilitata finche
non esistono manifest e receipt fisici verificabili e byte-bound, evidenze per
ciascuno dei 6 link e dei 4 attori, timestamp e provenance live. Lo stato
attuale non promuove B11 e non modifica il 49% ufficiale.

Lo schema 2 `MAXIMUM_VIRTUALIZED_SYSTEM_NON_GATE` resta la baseline software
storica da `9100/9100`; lo schema 1 da 10 nodi e `4500/4500` resta uno storico
riproducibile separato.
