# V5BT B0/B2 Two-Handheld Physical Diagnostic - 2026-08-05

## Ambito

Questo report registra il nuovo giro fisico eseguito con due Palmare Advanced
`1.0.38` code `39`. Il tablet Postazione certificato non era disponibile.
Tutte le misure sono quindi supplementari o diagnostiche e non sostituiscono
la coppia formale Palmare/Postazione.

| Campo | Valore |
| --- | --- |
| Classificazione | `PHYSICAL_DIAGNOSTIC` |
| Elegibilita gate | `NON_GATE_EVIDENCE` |
| B0-B5 | `PENDING` |
| B6 | chiusa |
| Avanzamento ufficiale | `49%` |

## B0 Supplementare

| Controllo | Palmare 1 | Palmare 2 |
| --- | --- | --- |
| Scan | `PASS` | `PASS` |
| Advertising | `PASS` | `PASS` |
| GATT client | `NOT_PROVEN` | `NOT_PROVEN` |
| GATT server | `NOT_PROVEN` | `NOT_PROVEN` |
| Scan/advertise concorrenti | `NOT_PROVEN` | `PASS` |
| Coesistenza Wi-Fi/BLE | `NOT_PROVEN` | `PASS` |
| Foreground/background | `NOT_PROVEN` | `PASS` |
| Continuita Android | `PASS` | `PASS` |

Il runner mantiene un esito fail-closed: i controlli non provati non vengono
inferiti dai controlli riusciti. Il risultato complessivo e
`SUPPLEMENTAL_FAIL`; B0 resta `PENDING`.

Il file privato B0 e un file regolare `0600` e il suo SHA-256 coincide con
quello dichiarato nel report redatto.

## B2 Diagnostico

| Metrica | Risultato |
| --- | ---: |
| Cicli richiesti/eseguiti | `100/100` |
| Cicli falliti | 0 |
| Presenza anonima minima/mediana/massima | 3.630 / 13.954 / 24.332 ms |
| Presenza anonima p95 | 16.465 ms |
| Cicli oltre 8 secondi | 63/100 |
| p95 dopo readiness di entrambi | 12.279 ms |
| Readiness di entrambi p95 | 4.437 ms |
| Soglia massima richiesta | 8.000 ms |

Tutti i cicli sono stati completati, ma il p95 supera la soglia. Il risultato
resta `NON_GATE_EVIDENCE` e B2 resta `PENDING`.

Scan failure, advertising failure, ingress drop e payload invalidi sono tutti
a zero. Sono state osservate due expiry peer: una al ciclo 33 e una al ciclo
59; in quest'ultimo caso un Palmare ha terminato in profilo `FAILOVER` senza
peer attivo. Entrambi i cicli hanno comunque completato la discovery entro il
timeout. Non risultano restart interni al ciclo, reporter stale, sequenze ferme,
radio inattiva o cleanup incompleto.

Il report B2 pubblico registra i controlli positivi su package, versione, code
e SHA-256 installato, ma non esporta i valori certificati o un digest della
matrice. La build e stata verificata nell'inventario privato del banco; il solo
report B2 non ne dimostra quindi autonomamente il binding crittografico.

## Diagnosi Tecnica

Il B0 corrente non puo chiudere GATT con questa build:

- il probe open/close del server GATT viene disabilitato quando il failover e
  attivo;
- il reporter Android non ha un runtime che possa mantenere
  `gattServerActive=true`, mentre il runner lo richiede in tutti i campioni;
- il client GATT Android accetta soltanto il server Raspberry e non puo essere
  provato usando due Palmare fra loro.

I tre controlli B0 non provati sul Palmare 1 sono compatibili anche con aliasing
temporale del runner: il campione arriva ogni 5 secondi, mentre una finestra
scan stabile dura 3 secondi ogni 30. Il dispositivo ha comunque incrementato
finestre scan e osservazioni in entrambe le fasi. La prossima versione dovra
registrare un contatore cumulativo di concorrenza scan/advertise e valutarne il
delta, invece di dipendere da un singolo stato istantaneo.

Nel B2, la readiness p95 di 4.437 ms e molto inferiore al p95 di presenza dopo
readiness di 12.279 ms. La distribuzione si concentra attorno alle finestre
FAILOVER da 8 secondi su periodo di 10 secondi. Il force-stop/rilancio ogni
ciclo e la pausa di soli 500 ms possono inoltre attivare il rate limiting degli
avvii scan Android. Prima di cambiare la politica radio occorre confrontare un
pilot da 20 cicli con almeno 31 secondi di quiescenza fra i cicli.

## Contratti Per Le Catture Future

Le evidenze di questo report restano immutate. Il runner B2 successivo usa lo
schema 6 e include un binding SHA-256 canonico alla matrice certificata. Il
monitor Raspberry successivo inserisce nell'attestazione redatta lo SHA-256
dell'intero journal privato finalizzato. Questi due interventi impediscono che
le lacune di binding osservate qui si ripetano nelle nuove catture.

## Continuita Raspberry

L'attestazione redatta si e conclusa `PASS`.

| Metrica | Risultato |
| --- | ---: |
| Durata | 1.985.782 ms |
| Campioni | 919 |
| Gap massimo | 6.140 ms |
| Servizi osservati | `PASS` |
| Boot | `PASS` |
| Clock | `PASS` |
| Assenza restart | `PASS` |
| Copertura polling | `PASS` |

Il monitor non ha fermato, riavviato o ricaricato i servizi osservati.
Il journal privato e un file regolare `0600` con 919 campioni contigui.
L'attestazione corrente non incorpora il suo SHA-256: la corrispondenza e stata
verificata semanticamente durante la revisione, ma non e dimostrabile dal solo
artefatto pubblico. Anche per questo l'attestazione resta supplementare.

## Logout Finale

Il controllo finale ha usato una finestra nominale di `135` secondi. Le due
finestre effettive sono state rispettivamente `139` e `142` secondi.

| Controllo post-logout | Risultato |
| --- | ---: |
| Poller | 0 |
| Trasporto | 0 |
| Batteria | 0 |
| Audio | 0 |
| Fatal | 0 |
| ANR | 0 |
| Stato auth residuo | 0 |
| Servizi applicativi | 0 |
| Notifiche | 0 |
| Schermata login visibile | entrambi i Palmare |
| Waiter server | 0 |

## Verifica Offline Finale

| Suite | Esito |
| --- | ---: |
| Test root | `49/49 PASS` |
| Test roadmap | `172 PASS`, `2 SKIP` storici attesi |
| Self-test B2 schema 6 | `133/133 PASS` |
| Contratti JSON | `22/22 PASS` |
| Manifest bidirezionale | `PASS` |
| Isolamento pacchetto | zero errori |

Il validatore mantiene correttamente disabilitata la promozione per le
evidenze fisiche esterne mancanti e non ricostruite.

## Stato Roadmap

L'assenza della Postazione certificata mantiene B0-B3 formali incompleti. I
risultati B0 e B2 di questo report non autorizzano B4, il pilot B5.7 o la
campagna B5. B0-B5 restano `PENDING`, B6 resta chiusa e l'avanzamento
ufficiale non cambia.

Avanzamento roadmap complessiva: **49%**
