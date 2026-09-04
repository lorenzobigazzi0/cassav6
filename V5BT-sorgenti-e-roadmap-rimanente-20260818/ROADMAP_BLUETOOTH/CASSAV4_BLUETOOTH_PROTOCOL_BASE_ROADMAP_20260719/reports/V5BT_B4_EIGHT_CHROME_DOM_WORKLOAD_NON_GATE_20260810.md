# V5BT - Workload DOM B4 Su Otto Palmare Chrome

Data: 2026-08-10  
Classe evidenza: `NON_GATE_EVIDENCE`  
Modalita: `EIGHT_CHROME_GUI_DOM_WORKLOAD_NON_GATE`  
Ultimo stato terminale: `NON_GATE_FAIL`
Aggiornamento: 2026-08-17

## Scopo

Il workload estende il banco grafico B4 con azioni eseguite attraverso il DOM
reale del frontend Palmare Advanced. Serve a verificare otto sessioni Chrome
mobile/touch concorrenti, cadenze operative e invio comande sull'ambiente
loopback isolato. Non simula BLE/GATT e non sostituisce dispositivi Android
fisici.

## Profilo Vincolante

| Voce | Valore |
| --- | ---: |
| Palmare Chrome | 8 |
| Azioni DOM per Palmare | 20 |
| Azioni DOM complessive | 160 |
| Comande per Palmare | 8 |
| Comande complessive | 64 |
| Cadenza azioni per Palmare | 3000 ms |
| Media cadenza comande | 7000-8000 ms |
| Azioni in-flight massime per Palmare | 1 |
| Intervallo aggiornamento batteria | 120000 ms |

Le otto sessioni corrispondono agli slot logici simulati `3..10`. Ogni azione
deve nascere da un'interazione DOM; non sono ammesse chiamate business dirette
iniettate dal driver. La pianificazione distribuisce le sessioni nel tempo,
mantiene seriali le azioni di ciascun Palmare e misura i dispatch effettivi.

## Implementazione

Il comando previsto e:

```bash
node scripts/run-v5bt-b4-web-gui-lab.mjs --workload
```

Il launcher accetta il workload soltanto con banco `ACTIVE`, heartbeat fresco,
otto contesti, otto pagine e otto sessioni valide. Pilot B5.7 e workload sono
mutuamente esclusivi. Il monitor persistente continua a sorvegliare pagine,
browser e fingerprint del ledger durante tutta l'esecuzione.

Richiesta e risultato sono artefatti privati distinti, regolari, `0600`, non
sovrascrivibili e vincolati da commitment. Il report pubblico e redatto: non
espone account, token, seriali, PID, percorsi, URL, hash privati o identificatori
del banco. Directory e file runtime restano esclusi dagli archivi sorgente.

## Verifica Richiesta

Il verdetto live puo essere `NON_GATE_PASS` soltanto se risultano tutti veri:

- `160/160` azioni DOM riuscite e `64/64` comande confermate;
- media della cadenza comande compresa fra `7000` e `8000 ms`;
- cadenza azioni conforme a `3000 ms`, senza recuperi a raffica;
- massimo una azione in-flight per Palmare e otto sessioni preservate;
- zero errori DOM, pagina, rete business o HTTP inattesi;
- batteria limitata a un aggiornamento ogni `120000 ms`;
- ledger fisico ancora `2/10`, identico byte per byte;
- zero accessi hardware e zero scritture su gate o campagna ufficiale.

Ogni conteggio incompleto, cadenza fuori contratto, sessione persa, errore,
manomissione o variazione del ledger produce `NON_GATE_FAIL`. Il primo risultato
terminale resta immutabile e non viene sovrascritto.

## Stato Della Verifica

| Controllo | Stato |
| --- | --- |
| Contratto workload DOM | `IMPLEMENTED` |
| Primo run immutabile | `NON_GATE_FAIL`, 26/160 azioni, 10/64 comande |
| Secondo run immutabile | `NON_GATE_FAIL`, 83/160 azioni, 33/64 comande |
| Errori HTTP secondo run | 513 |
| Confronto ledger | byte-identico, 2/10 fisici |
| Verdetto live piu recente | `NON_GATE_FAIL` |

Entrambi i risultati terminali restano conservati e non vengono sovrascritti.
Il secondo run ha consentito di correggere l'adozione immediata dei `lineId`
canonici restituiti dal server, la correlazione delle mutazioni, il recupero
degli overlay, il drain delle azioni in-flight e il controllo fail-closed della
Postazione isolata. Le suite mirate successive chiudono `54/54 PASS`; il
workload completo dopo queste correzioni non e ancora stato rieseguito. Questo
documento non dichiara quindi un PASS live.

## Impatto Sui Gate

```text
hardware B4 ufficiali = 2/10
Palmare Chrome conteggiati nel gate = 0
B4 = PENDING
B5 = PENDING, 0/100 sessioni ufficiali
B6 = BLOCKED
hardware usato dal workload = no
avanzamento ufficiale modificato = no
```

Avanzamento roadmap complessiva: **49%**
