# V5BT - Ripresa fisica con due Android

Data di riferimento: **2026-08-03**  
Classificazione: **report pubblico redatto**  
Avanzamento roadmap complessiva: **49%**

> Nota di stato: il corpo e l'addendum seguente sono snapshot intermedi. La
> chiusura autorevole corrente e in `V5BT_B2_RADIO_HYSTERESIS_20260804.md`.

## Addendum di ricertificazione 2026-08-04

Il corpo datato 3 agosto riportato di seguito resta il resoconto storico della
ripresa iniziale. La ricertificazione successiva ha corretto il server
predefinito Palmare a
`https://192.168.1.79:5380/mobile/`, mantenendo il valore corrente gia
configurato e classificando come legacy soltanto `192.168.0.67` e
`192.168.1.182`.

Palmare Advanced Lab `1.0.36` code `37` e stato ricostruito con SHA-256
`6ba726c47fbcf7fd36cec209249be528330a65b8a14cdd95f6020dcf12dba370`
e firma invariata. La suite Android ha chiuso `183/183` PASS; lint ha chiuso
con zero errori, 23 warning e una informazione. La build e stata installata
con aggiornamento conservativo sui due Palmare, senza cancellare dati,
identita o enrollment.

L'inventario post-fix e valido per i controlli Android, Raspberry, servizi,
registry ed enrollment. Il riepilogo resta `INCOMPLETE` soltanto perche il
probe dati UPS non e disponibile; non e stato assunto alcun driver.

La nuova cattura B0 supplementare e durata 120 secondi ed e conservata in
`reports/physical/v5bt-b0-two-handheld-supplemental-20260804.json`.
Continuita, coesistenza Wi-Fi/BLE e
foreground/background sono `PASS`; scan, advertising, GATT client/server e
concorrenza scan-advertise non sono stati dimostrati esplicitamente. L'esito
resta `SUPPLEMENTAL_FAIL`, non promuove B0 e lascia il gate formale `PENDING`.

Gli artefatti B2 precedenti restano conservati senza sovrascrittura. Il terzo
retry post-fix e pubblicato in
`reports/physical/v5bt-b2-two-handheld-non-gate-20260804-retry3.json`: ha
eseguito tutti i `100/100` cicli numerati, con 73 `PASS`, 27 timeout di
presenza anonima e p95 di 14.276 ms rispetto al massimo di 8.000 ms. Il
risultato e `PENDING`, `NON_GATE_EVIDENCE`, non e eleggibile alla
certificazione e non promuove B2.

L'inventario finale redatto e in
`reports/physical/v5bt-two-handheld-final-inventory-redacted-20260804.json`.
Entrambi i Palmare risultano autenticati, `READY`, distinti e coerenti con il
registry; il solo controllo incompleto resta il probe dati UPS. Il monitor
Raspberry ha coperto 4.963.777 ms con 2.463 campioni e ha chiuso `PASS` senza
reboot o restart dei servizi. L'attestazione redatta e in
`reports/physical/v5bt-raspberry-continuity-supplemental-20260804.json`.

Il dettaglio della ricertificazione e pubblicato in
`reports/V5BT_PALMARE_LAB_RECERTIFICATION_20260804.md`.

Avanzamento roadmap complessiva: **49%**

## Perimetro

La ripresa ha impiegato due telefoni Android 16/API 36, entrambi mantenuti nel
ruolo Palmare Advanced. Il tablet Postazione Advanced certificato non era
disponibile. Le prove con i soli Palmare sono quindi supplementari o
diagnostiche e non sostituiscono i gate formali che richiedono la coppia
Palmare/Postazione.

Il report espone soltanto dati aggregati e redatti. Le evidenze riservate e gli
artefatti di rollback restano fuori dal pacchetto pubblico.

## Inventario e preparazione

L'inventario read-only del banco ha rilevato due target Android attesi e il
Raspberry raggiungibile. Package, versione, code, SHA-256, permessi e stato di
enrollment dei due Palmare risultano coerenti. BlueZ 5.82 e disponibile con
adapter acceso, NTP e sincronizzato e i due servizi protetti risultano attivi.

Lo stato complessivo dell'inventario e `INCOMPLETE` esclusivamente per il
rilievo UPS: non e disponibile un probe dati interrogabile. L'UPS e rimasto in
sola discovery e non e stato ipotizzato o installato alcun driver.

Prima dell'aggiornamento sono stati conservati privatamente APK, hash e stato
applicativo necessari al rollback. Palmare Advanced Lab `1.0.36` code `37` e
stato poi installato su entrambi i telefoni con aggiornamento conservativo
`adb install -r -g`. Non sono stati eseguiti uninstall, `pm clear`,
cancellazioni dati, cambi utente Android o nuove enrollment. La verifica
successiva ha confermato versione, code, APK certificato, firma, permessi,
accesso `run-as` e assenza di variazioni delle identita preesistenti.

I servizi `cassav5bt.service` e `bluetooth.service` non sono stati fermati o
riavviati durante le attivita qui documentate. Il monitor di continuita
Raspberry e stato avviato prima delle prove; la sua attestazione finale resta
un artefatto separato e non viene anticipata da questo report.

## Esiti

### B0 - capability supplementari

La cattura e durata 120 secondi ed e pubblicata in
`reports/physical/v5bt-b0-two-handheld-supplemental-20260803.json`. Entrambi i
telefoni hanno mantenuto stabili package/versione, utente Android, processo,
reporter, contesto autenticato, clock, polling e servizio, senza crash o ANR.

| Controllo | Palmare 1 | Palmare 2 |
| --- | --- | --- |
| scan | `FAIL / SCAN_NOT_PROVEN` | `FAIL / SCAN_NOT_PROVEN` |
| advertising | `FAIL / ADVERTISING_NOT_PROVEN` | `FAIL / ADVERTISING_NOT_PROVEN` |
| GATT client | `FAIL / GATT_CLIENT_NOT_PROVEN` | `FAIL / GATT_CLIENT_NOT_PROVEN` |
| GATT server | `FAIL / GATT_SERVER_NOT_PROVEN` | `FAIL / GATT_SERVER_NOT_PROVEN` |
| scan + advertising concorrenti | `FAIL / SCAN_ADVERTISE_CONCURRENCY_NOT_PROVEN` | `FAIL / SCAN_ADVERTISE_CONCURRENCY_NOT_PROVEN` |
| coesistenza Wi-Fi/BLE | `PASS` | `PASS` |
| foreground/background | `PASS` | `PASS` |

I contatori hanno registrato 15 finestre scan aggiuntive per telefono e,
rispettivamente, 13 e 16 osservazioni accettate. Questi contatori non
sostituiscono le prove esplicite delle capability mancanti: il runner ha
quindi chiuso correttamente in fail-closed con `SUPPLEMENTAL_FAIL`. L'evidenza
e `NON_GATE_EVIDENCE`, non promuove B0 e lascia il gate formale `PENDING` in
attesa della Postazione certificata.

### B1 - identita ed enrollment

La rivalidazione read-only e completata. Le due identita preesistenti sono
distinte, in stato `READY` e coerenti con i rispettivi binding nel registry
Raspberry. Non e stata creata alcuna nuova identita e non e stato modificato
il registry.

### B2 - diagnostico tra due Palmare

Il primo tentativo diagnostico e conservato immutabile in
`reports/physical/v5bt-b2-two-handheld-non-gate-20260803.json`. Il runner
richiedeva 100 cicli, ma si e arrestato in modo fail-closed al ciclo 1 con
`STATUS_INVALID`: zero cicli completati, uno fallito ed evidenza live
incompleta.

L'artefatto resta `NON_GATE_EVIDENCE`, non e eleggibile alla certificazione e
non modifica i 100 cicli formali Palmare/Postazione ancora richiesti. Analisi,
remediation ed eventuale retry con un nuovo output sono `PENDING`; il primo
artefatto non verra sovrascritto.

### B3 - soak Android

Non eseguito. Il soak formale da 3600 secondi richiede il tablet Postazione
Advanced certificato, che non era disponibile.

### B4 - raccolta su hardware distinto

La sintesi pubblica storica riporta `1/10`, ma lo state privato, la chiave e le
coppie report/log originali necessarie alla rivalidazione non sono
disponibili. La sola sintesi pubblica non e sufficiente per riprendere il
ledger. Non sono stati ricostruiti o sovrascritti stato o evidenze e nessun
nuovo dispositivo e stato acquisito o conteggiato.

B4 resta `PENDING` e la raccolta storica non e riprendibile senza gli
artefatti privati originari integri.

### B5 e B6

Il pilot B5.7, la campagna B5 da 100 sessioni e B6 non sono stati eseguiti.
B5 resta `PENDING`; B6 resta chiusa fino al completamento dei prerequisiti e
alla promozione formale di B5.

## Conclusione

La ripresa ha verificato in modo conservativo installazione, continuita e
binding B1 dei due Palmare senza modificare API business, server operativo o
database. Le evidenze B0 e B2 restano non promuovibili, B3 e bloccato
dall'assenza della Postazione e B4 non puo ripartire dalla sola sintesi
storica. Nessun nuovo gate formale e stato promosso.

Avanzamento roadmap complessiva: **49%**
