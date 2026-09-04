# V5BT - Roadmap Rimanente

Data snapshot: 2026-08-18  
Stato ufficiale di riferimento: 2026-08-10  
Avanzamento ufficiale: **49%**

## Regola Di Lettura

La preparazione software e offline e ampia e il core transport B7-B11 ha
chiuso `NON_GATE_PASS`, ma le prove sintetiche e i browser
Chrome non sostituiscono le evidenze fisiche. Gli otto Palmare Chrome coprono
gli slot logici `3..10`, ma valgono `0` dispositivi nel gate B4. Nessuna prova
non-gate autorizza B5 o modifica la percentuale ufficiale.

## Stato Dei Gate

| Fase | Stato | Lavoro rimanente |
| --- | --- | --- |
| **B0 - Capability hardware** | `PENDING` | Ripetere l'inventario read-only fino a `COMPLETE` con Palmare e Postazione certificati, Raspberry, BlueZ, NTP, servizi e registry disponibili. Scan, advertising, GATT client/server, scan+advertise concorrenti, Wi-Fi/BLE e foreground/background devono essere `PASS` sui due ruoli formali. |
| **B1 - Protocollo, identita e provisioning** | `PENDING` fisico | Rivalidare enrollment `READY`, Android Keystore, identita e binding col registry Raspberry sui target correnti, inclusa la Postazione. Non creare nuove identita se quelle esistenti sono integre. |
| **B2 - Discovery BLE** | `PENDING` | Eseguire `100/100` discovery reciproche Palmare/Postazione con p95 `<= 8000 ms`, zero errori radio e build/hash conformi. Il diagnostico storico fra due Palmare, `95/100` con cinque timeout, e solo `NON_GATE_EVIDENCE`. |
| **B3 - Agent Android** | `PENDING` | Eseguire il soak non abbreviabile di `3600 s` sui due target certificati, senza gap di monitor, crash, ANR, restart, transizioni illegali o risorse residue. |
| **B4 - Nodo Raspberry e dieci hardware** | `PENDING`, `2/10` | Rivalidare i due record esistenti senza riacquisirli e aggiungere otto hardware fisici distinti, una sola volta ciascuno. Il banco Chrome mantiene copertura logica `SIMULATED_10_OF_10`, ma conta `0` nel gate. |
| **B5 - Android-Raspberry** | `PENDING`, `0/100` | Dopo PASS B0-B3 e rivalidazione B4 eseguire un solo pilot diagnostico separato. La campagna ufficiale parte soltanto dopo PASS B0-B4: stesso Palmare/build/account, slot seriali `001..100`, monitor Android e Raspberry continui, manifest, aggregate, receipt, review indipendente e promotion gate. |
| **B6 - Android-Android** | software core `NON_GATE_PASS`; fisico `PENDING/BLOCKED` | Si apre fisicamente soltanto dopo promozione formale B5. Eseguire role election, A2, DATA/ACK e cento sessioni per ogni coppia certificata su radio reale. |
| **B7 - Canale affidabile** | software `NON_GATE_PASS`; fisico `PENDING` | Frame v1, frammentazione, AEAD, ACK/retry, dedup e TTL sono implementati. Validare perdita, duplicazione, MTU e retry su radio reale. |
| **B8 - Durabilita locale** | software `NON_GATE_PASS`; fisico `PENDING` | Outbox, inbox dedup, history e route persistente sono implementati e legati al peer. Validare reboot/process death reali senza perdita durable. |
| **B9 - Route advertisement** | software `NON_GATE_PASS`; fisico `PENDING` | Provider dinamico e fail-closed implementati. Misurare sul Raspberry fisico perdita/riacquisizione route e SLA di cinque secondi; batteria/UPS restano `UNKNOWN`. |
| **B10 - Command bus shadow** | software `NON_GATE_PASS`; fisico `PENDING` | Shadow `HEALTH/PING/TEST` implementato, traffico business sempre LAN. Confermare sul banco reale che il comportamento POS resti invariato. |
| **B11 - Test, soak e pilot** | massimo misto schema 3 `MIXED_NON_GATE_INCOMPLETE`; fisico `PENDING` | Target: 2 Palmari fisici + 8 virtuali, 1 Postazione fisica + 2 virtuali, 1 Raspberry fisico, cassa e RT virtuali. Corrente: 2/4 fisici osservati, cioe i due Palmari; Postazione e Raspberry 0/1; radio/business/monitor/soak `NOT_RUN`. Lo schema 2 tutto virtuale resta storico `NON_GATE_PASS 9100/9100`. |

## Target Certificati Correnti

| Ruolo | Applicazione | Versione | Code |
| --- | --- | ---: | ---: |
| Palmare | Palmare Advanced | `1.0.39` | `40` |
| Postazione | Postazione Advanced | `2.0.23` | `25` |

Package ID, SHA-256 degli artefatti e certificato di firma sono centralizzati
in
`ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/configs/advanced-certification-targets.json`.
Gli APK non sono inclusi nello ZIP sorgente e vanno ricompilati.

## Blocker Attuali

1. La Postazione certificata non era disponibile nell'ultima ripresa fisica.
2. Raspberry, BlueZ, NTP, servizi, registry e UPS devono essere nuovamente
   interrogabili durante il preflight autorevole.
3. Mancano otto hardware fisici distinti per chiudere B4.
4. I due Palmare vanno portati in sessione controllata con reporter fresco e
   monitor Android/Raspberry gia attivi prima delle prove.
5. Sei artefatti storici restano `UNAVAILABLE` e `mustNotBeSynthesized`: non
   devono essere ricostruiti.
6. B5 manca ancora dell'autorizzazione B0-B4, delle cento sessioni ufficiali,
   del receipt di campagna e dei sign-off reali. Il meccanismo account/device
   commitment e implementato, ma nessun hardware e stato usato e nessuna
   promozione e avvenuta.

## Stato Del Banco Chrome Non-Gate

Il banco base da otto Palmare Chrome e il rehearsal loopback sono separati
dalle prove radio. I due workload del 10 agosto restano storici e non vengono
sovrascritti:

- primo run: `26/160` azioni e `10/64` comande;
- secondo run: `83/160` azioni e `33/64` comande, con `513` risposte HTTP
  inattese.

Dopo quei run sono stati corretti il recupero degli overlay, la correlazione
delle mutazioni, l'adozione immediata dei `lineId` canonici restituiti dal
server, il drain delle azioni in-flight e il controllo della Postazione
isolata.

Il 18 agosto sono stati conservati tre nuovi run immutabili:

- primo: `160/160`, `114` successi, `46` failure e conteggio HTTP `565`;
- secondo: abort a `87/160`;
- terzo: `130/160`, `113` successi, `17` failure, zero HTTP failure e
  `stopReason=PAGE_CLOSED`.

L'esito finale e `NON_GATE_FAIL`; non sono previsti altri retry. Le suite
delle correzioni chiudono `75/75 PASS` e quelle aggiuntive `55/55 PASS`, ma il
residuo sotto carico resta aperto. Il ledger fisico, i gate e la percentuale
ufficiale non cambiano.

## Consolidamento Software Del 2026-08-18

La precedente chiusura va letta come chiusura del core transport/software, non
dell'intera roadmap. B7-B11 sono `NON_GATE_PASS` software e restano `PENDING`
sul piano fisico. I flag prodotto restano OFF e nessun trasporto business e
stato spostato su Bluetooth.

Aggiornamenti verificati:

- Raspberry/Node 24 `318/318 PASS`; `303/303` resta lo snapshot consolidato
  precedente e `292/292` quello della telemetria periodica;
- B11 baseline schema 2 runner+helper `17/17 PASS`: 16 attori virtuali,
  `9100/9100` cicli e zero accessi fisici, senza promozione;
- B11 massimo schema 3 `MIXED_NON_GATE_INCOMPLETE`: 2/4 attori fisici
  osservati, cioe i due Palmari; Postazione e Raspberry 0/1; campagna
  fisica `NOT_RUN`. Il contratto corrente e incomplete-only; readiness 4/4,
  600 cicli real-real, 600 azioni incluse 160 comande, monitor 4/4 e soak
  fisico di due ore restano criteri per una futura versione, bloccata fino a
  manifest/receipt byte-bound, record per-link/per-actor, timestamp e
  provenance live;
- nel v3 corrente `WAIVED_NON_GATE` e solo metadato/policy futura: non rende
  readiness operativa. L'inventario certifica l'APK con SHA-256 byte-esatto e
  deriva la copertura signer dallo stesso binding, quindi un signer ignorato
  lascia l'APK non certificato e il profilo `INCOMPLETE`; non viene aggiunta
  una probe signer separata;
- Postazione `api31Compat` full offline `374/374 PASS`, lint e assemble
  `PASS`; configurazione `NON_INSTALLATA` e fix API 24 incluso;
- focus A2 Palmare `18/18 PASS`;
- badge diagnostico frontend Palmare/Postazione completato, nascosto senza
  flag o bridge, bounded e fail-closed, senza identificatori o claim business;
  verifiche `6/6` Palmare, `39/39` Postazione, typecheck/build e quattro
  viewport;
- P-010 avanzato per tranche: storage diretto eliminato nel perimetro previsto
  e facade analytics separato in tipi, normalizzatori e builder puri, con
  export, HTTP e payload fiscali invariati;
- commitment account/device B5 implementato: digest canonico domain-separated
  redatto nello state schema `3`, nei `100` record, nell'attestazione Android
  `1.1`, nell'aggregate `1.5` e nel receipt `1.1`; la promotion `1.3` ricalcola
  dai tre input raw i digest attesi, mentre il legacy resta read-only e
  `PENDING`.

Per P-010 `reservations.ts`, identico nelle due tree, e stato estratto in
`reservationModel.ts`; il facade passa da `1229` a `983` righe logiche e i
mirati chiudono `21/21 PASS` per tree. Le estrazioni della policy prodotto del
composer e del modello recovery chiudono `6/6` e `11/11 PASS` per tree. La
rimozione di `38` priorita CSS ridondanti e stata verificata su `84` varianti e
due viewport senza differenze di stile o pixel: il conteggio `!important`
scende da `305` al budget `267`. Architecture chiude `11/12 PASS` per tree e
resta bloccata soltanto dal gate LOC sui quattro monoliti TSX
`TablePaymentWizard`, `TablesWorkspace`, `PaymentSettlementSection` e
`AnalyticsWorkspace`. Le suite funzionali analytics restano `465/465` e
`469/469`; typecheck e build sono positivi.

Il commitment B5 chiude mirati `83/83 PASS` e Raspberry `303/303 PASS`. E una
chiusura software: B5 resta `PENDING` e
l'avanzamento ufficiale non cambia.

## Ordine Di Ripresa

1. Rendere disponibile il banco completo ed eseguire inventario read-only
   `COMPLETE`.
2. Avviare i monitor, effettuare login controllato e verificare build, hash,
   enrollment e reporter freschi.
3. Chiudere B0, B1, B2 `100/100` e B3 `3600 s`.
4. Acquisire gli otto nuovi hardware e portare B4 a `10/10`.
5. Eseguire il pilot B5 separato; poi nuova campagna ufficiale `100/100`,
   revisione e promozione.
6. Ripristinare conservativamente le build normali e validare fisicamente, in
   ordine, B6, B7, B8, B9, B10 e B11 sulla baseline software congelata.

## File Autorevoli Nel Pacchetto

- `README_V5BT.md`
- `DOCUMENTAZIONE/WORKSPACE_ATTIVA.md`
- `DOCUMENTAZIONE/V5BT_ROADMAP_PHYSICAL_PREFLIGHT_20260810.md`
- `HANDOFF_V5BT_20260724.md`
- `ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/README.md`
- `ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/configs/current-roadmap-status.json`
- `ROADMAP_BLUETOOTH/CASSAV4_BLUETOOTH_PROTOCOL_BASE_ROADMAP_20260719/configs/external-evidence-status.json`
- i runbook sotto `testing/` e i report pubblici/redatti sotto `reports/`.

Runtime, state, ledger, registry, diagnostica privata, chiavi, log e artefatti
ricompilabili sono deliberatamente esclusi dallo ZIP. Restano incluse soltanto
le due baseline SQLite certificate richieste dal provisioning e i dump SQL di
provisioning; per questo l'archivio va trattato come sensibile.

Avanzamento roadmap complessiva: **49%**
