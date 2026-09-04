# V5BT - Ricertificazione Palmare Lab

Data: **2026-08-04**  
Classificazione: **report pubblico redatto**  
Avanzamento roadmap complessiva: **49%**

> Nota di stato: questo e uno snapshot intermedio. La chiusura autorevole della
> ricertificazione radio e in `V5BT_B2_RADIO_HYSTERESIS_20260804.md`.

## Scopo

Questa ricertificazione documenta la correzione del server Palmare, la nuova
build Lab, l'aggiornamento conservativo dei due Palmare e le verifiche fisiche
post-fix. Non modifica API business, server operativo, database o criteri di
promozione dei gate.

Il report non contiene seriali Android, identita di enrollment, PID, hostname,
percorsi privati o credenziali.

## Correzione URL

Il server predefinito Palmare e:

```text
https://192.168.1.79:5380/mobile/
```

La risoluzione della configurazione applica queste regole:

- un URL corrente gia salvato viene conservato;
- `https://192.168.0.67:5380/mobile/` viene migrato al default corrente;
- `https://192.168.1.182:5380/mobile/` viene migrato al default corrente;
- l'URL corrente non appartiene piu all'insieme legacy.

## Build Ricertificata

| Campo | Valore |
| --- | --- |
| Applicazione | Palmare Advanced Lab B5.7 |
| Package | `com.sentrapa.palmare.advanced` |
| Versione | `1.0.36` |
| Version code | `37` |
| SHA-256 | `6ba726c47fbcf7fd36cec209249be528330a65b8a14cdd95f6020dcf12dba370` |
| Firma | invariata rispetto alla build Lab attesa |

La verifica Android ha prodotto:

```text
Test unitari: 183/183 PASS
Lint:         0 errori, 23 warning, 1 informazione
Build APK:    PASS
```

La build mantiene attivi i flag Lab, diagnostics, identity, discovery,
failover, GATT client, HELLO exchange, mutual auth, session key e heartbeat.
Direct server e peer link restano disattivati.

## Installazione E Inventario

La build ricertificata e stata installata sui due Palmare con aggiornamento
conservativo `adb install -r -g`. Non sono stati eseguiti uninstall,
`pm clear`, cambio utente Android, cancellazione dati o nuova enrollment. La
firma e le identita preesistenti sono rimaste invariate.

L'inventario read-only post-fix e valido per package, versione, code, hash,
permessi, enrollment, registry, Raspberry, BlueZ, NTP e servizi osservati. Il
riepilogo resta `INCOMPLETE` esclusivamente perche non e disponibile un probe
dati UPS interrogabile. Nessun protocollo o driver UPS e stato inventato.

## B0 Supplementare

La cattura post-fix su due Palmare e durata 120 secondi. Il risultato e
`SUPPLEMENTAL_FAIL` e il gate formale resta `PENDING`. L'evidenza pubblica
redatta e
`reports/physical/v5bt-b0-two-handheld-supplemental-20260804.json`.

| Controllo | Esito aggregato |
| --- | --- |
| continuita app e monitor | `PASS` |
| coesistenza Wi-Fi/BLE | `PASS` |
| foreground/background | `PASS` |
| scan esplicito | non dimostrato |
| advertising esplicito | non dimostrato |
| GATT client esplicito | non dimostrato |
| GATT server esplicito | non dimostrato |
| scan e advertising concorrenti | non dimostrato |

Il fail-closed e corretto: le osservazioni aggregate non sostituiscono una
prova esplicita delle capability radio richieste e l'evidenza supplementare
non puo promuovere B0.

## B2

I tentativi diagnostici B2 prodotti prima della ricertificazione restano
conservati e non vengono sovrascritti o reinterpretati. Il retry post-fix e
stato eseguito su un nuovo output immutabile:
`reports/physical/v5bt-b2-two-handheld-non-gate-20260804-retry3.json`.

| Misura | Valore |
| --- | ---: |
| cicli richiesti/eseguiti | `100/100` |
| cicli `PASS` | 73 |
| timeout di presenza anonima | 27 |
| p95 osservato | 14.276 ms |
| p95 massimo | 8.000 ms |

Il risultato e `PENDING`, `NON_GATE_EVIDENCE`, con promozione B2 disabilitata.
La coppia di soli Palmare non e eleggibile alla certificazione formale e non
sostituisce la prova Palmare/Postazione.

## Chiusura Della Cattura

L'inventario finale conferma entrambi i Palmare autenticati, `READY`, distinti
e coerenti con il registry. Package, versione, code, hash, permessi e utente
Android restano conformi; lo stato `INCOMPLETE` dipende soltanto dal probe dati
UPS non disponibile. Il report redatto e
`reports/physical/v5bt-two-handheld-final-inventory-redacted-20260804.json`.

Il monitor Raspberry ha coperto 4.963.777 ms con 2.463 campioni e ha chiuso
`PASS`: boot e clock sono rimasti stabili, i servizi principale e Bluetooth
sono rimasti continui e non sono stati osservati restart. L'attestazione
redatta e
`reports/physical/v5bt-raspberry-continuity-supplemental-20260804.json`.

## Conclusione

La correzione URL, la build e la reinstallazione conservativa sono
ricertificate. B0 resta `SUPPLEMENTAL_FAIL/PENDING`; B2 ha una nuova evidenza
diagnostica completa ma non conforme e resta `PENDING`; B3-B6 restano
invariati. Nessun gate formale e stato promosso e la percentuale ufficiale non
cambia.

Avanzamento roadmap complessiva: **49%**
