# 16 — Sequenziamento con gli altri programmi V6

## Programmi aperti contemporaneamente

Verificato nel pacchetto sorgente:

| Programma | Stato dichiarato | Perimetro |
|---|---|---|
| `ROADMAP_V6` — Commerciale V2 | `officialProgressPercent: 0`, promozione non autorizzata, 9 fasi | prodotto/catalogo/listini/offerte, motore prezzi |
| `ROADMAP_V6/BLUETOOTH` | pacchetto protocollo 20260820 | trasporto Bluetooth palmari/postazioni |
| Questa roadmap | REV2 | motore di persistenza |

`ROADMAP_V6/configs/current-roadmap-status.json` dichiara per Commerciale V2 il
percorso obbligatorio `off -> bootstrap -> shadow -> canary -> primary` e classifica
tutto il codice importato come `CANDIDATE_IMPORTED_NOT_VERIFIED`, cioe credito zero.

## Il conflitto

`MIG-040` chiede di unificare `menuItems` e `commercial_products` in un unico
product master. Questa e una **decisione di Commerciale V2**, non della migrazione:
riguarda quale identita di prodotto e canonica, cosa viene versionato e cosa no
(vedi `COM-01`). Commerciale V2 non l'ha chiusa.

Eseguire i due programmi in parallelo significa cambiare **il modello di prezzo e
il motore di persistenza nello stesso periodo**. E la stessa cosa che
`11_CODEX_EXECUTION_GUIDE.md` vieta a livello di commit ("evitare commit
monolitici che cambiano simultaneamente persistence engine, business rules e UI"),
applicata al livello di programma.

Se dopo il cutover un prezzo risulta sbagliato, non sara attribuibile: puo essere
la risoluzione del listino, puo essere la migrazione dei dati.

## Opzioni

### Opzione A — Commerciale V2 prima, su storage attuale (consigliata)

Portare Commerciale V2 fino a `primary` sull'attuale persistenza, con i suoi
golden test di pricing verdi. Poi migrare, con il modello commerciale gia
stabilizzato e i test di equivalenza gia scritti.

- Vantaggio: `MIG-040/041/042/043/044` diventano una traduzione di schema con
  oracolo gia esistente, non una riprogettazione.
- Costo: si investe su SQLite relational lavoro che verra poi tradotto.
  Accettabile: il doc 01 dice gia che quel lavoro e specifica comportamentale.

### Opzione B — Congelare Commerciale V2 a `off`, migrare, poi riprendere

Migrare `menuItems` legacy come unico product master, portare tutto su PostgreSQL,
e riprendere Commerciale V2 dopo il cutover, direttamente su PostgreSQL.

- Vantaggio: un solo modello commerciale attraversa la migrazione.
- Costo: Commerciale V2 slitta di tutto il programma; se e gia atteso da utenti,
  non e praticabile.

### Opzione C — Parallelo

Sconsigliata per i motivi sopra. Se viene scelta comunque, servono almeno:
un golden dataset di pricing congelato **prima** di entrambi i programmi, e
l'impegno che nessun cambiamento di semantica commerciale entri durante le fasi
P4-P8 della migrazione.

## Bluetooth

Il programma Bluetooth tocca il trasporto, non la persistenza, quindi non collide
direttamente. Collide sulle **risorse** e sul **collaudo fisico**: entrambi i
programmi richiedono sessioni di test sull'hardware reale con palmari e postazioni.
Vanno pianificate le finestre di collaudo, non le sole finestre di sviluppo.

## Decisione richiesta

`SEQ-01` in `12_OPEN_DECISIONS.md`. Va chiusa **prima di P4**, non prima di P0:
P0-P3 sono eseguibili in ogni scenario.
