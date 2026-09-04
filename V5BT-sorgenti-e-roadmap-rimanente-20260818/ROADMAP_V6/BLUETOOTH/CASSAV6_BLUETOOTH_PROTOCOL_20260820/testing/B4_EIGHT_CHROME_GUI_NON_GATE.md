# B4 - Otto Palmare Web Grafici Non-Gate

## Scopo

Questo banco completa gli slot logici `3..10` con otto Palmare web grafici in
Chrome. Serve a provare interfaccia, login, isolamento delle sessioni e flusso
applicativo con una copertura simulata `10/10`; non sostituisce le acquisizioni
BLE richieste dal gate fisico B4.

Sul banco persistente e disponibile anche un workload DOM non-gate. Il
workload esercita le otto sessioni tramite interazioni grafiche reali e non
tramite chiamate API iniettate, ma resta una prova applicativa sintetica e non
una cattura radio.

Il launcher operativo e:

```text
SORGENTE_SISTEMA/cassa-frontend/scripts/run-v6-b4-web-gui-lab.mjs
```

## Contratto

- esattamente otto contesti, pagine e sessioni Chrome, per gli slot `3..10`;
- account di laboratorio distinti, abilitati soltanto a Palmare, con PIN
  `1234`;
- frontend e backend isolati su loopback, I/O hardware disabilitato;
- richieste browser verso host non loopback bloccate;
- ledger fisico schema `2`, file regolare `0600`, un solo link e due record;
- fingerprint del ledger verificato all'avvio e ogni cinque secondi;
- nessuna lettura della directory delle evidenze fisiche;
- screenshot e stato runtime soltanto nella directory privata `.runtime`, con
  directory `0700` e file `0600`;
- chiusura di pagina, browser disconnesso o variazione del ledger invalidano il
  banco.

### Contratto workload DOM

- otto Palmare Chrome con emulazione mobile/touch, sessioni distinte e gia
  autenticate;
- `20` azioni DOM seriali per Palmare, `160` complessive;
- `8` invii comanda per Palmare, `64` complessivi;
- cadenza minima delle azioni dello stesso Palmare pari a `3000 ms`;
- media della cadenza di invio comande compresa fra `7000` e `8000 ms`;
- massimo una azione in-flight per ciascun Palmare;
- batteria configurata per un solo aggiornamento ogni `120000 ms`;
- sessione autenticata preservata dall'inizio alla fine;
- richiesta e risultato privati, regolari, `0600`, non sovrascrivibili e
  legati fra loro da commitment;
- report esportabile redatto, senza account, token, PID, percorsi, URL, hash
  privati o identificatori dei dispositivi;
- nessun accesso ad ADB, SSH, Bluetooth, GATT, Raspberry o UPS;
- nessuna scrittura sul ledger B4 fisico, sul collector B5 o sul relativo
  supervisor.

Il supervisore continua il controllo di heartbeat e ledger mentre il workload
e in corso. Richiesta non valida, banco diverso da `ACTIVE`, heartbeat non
fresco, conteggio diverso da `8/8`, sessione persa, errore DOM/HTTP, concorrenza
per Palmare maggiore di uno, conteggi o cadenze fuori contratto e variazione
del ledger producono un esito fail-closed. Pilot e workload non possono essere
eseguiti contemporaneamente.

## Comandi

Da `SORGENTE_SISTEMA/cassa-frontend`:

```bash
node scripts/run-v6-b4-web-gui-lab.mjs --dry-run
node --test scripts/run-v6-b4-web-gui-lab.test.mjs
node scripts/run-v6-b4-web-gui-lab.mjs --start
node scripts/run-v6-b4-web-gui-lab.mjs --status
node scripts/run-v6-b4-web-gui-lab.mjs --workload
node scripts/run-v6-b4-web-gui-lab.mjs --pilot
node scripts/run-v6-b4-web-gui-lab.mjs --stop
```

`--start` crea un supervisore persistente e restituisce soltanto dopo il login
GUI di tutti gli otto Palmare. `--status` non esporta PID, percorsi, account,
UUID o token. `--stop` segnala esclusivamente il processo verificato del banco
e chiude browser, frontend e backend isolati.

`--pilot` esegue un rehearsal web B5.7 separato, descritto in
`testing/B5_WEB_GUI_LOOPBACK_DIAGNOSTIC.md`; non e una prova radio e non
modifica alcun gate.

`--workload` richiede un banco gia `ACTIVE` e fresco, mantiene attivo il
monitor del launcher e attende un risultato terminale redatto. Il comando non
puo inizializzare il ledger, aggiungere record fisici, autorizzare B5 o
incrementare sessioni ufficiali. Un risultato privato gia presente non viene
sovrascritto.

## Risultato Ammesso

Il solo risultato positivo e `NON_GATE_PASS`, con:

```text
copertura logica simulata = 10/10
hardware fisici ufficiali = 2/10
simulati conteggiati nel gate = 0
B4 = PENDING
B5 = PENDING
B6 = BLOCKED
```

La copertura web puo quindi essere considerata chiusa per i test grafici, ma
non autorizza il pilot o la campagna B5 e non modifica la percentuale ufficiale.

Il workload ha un verdetto separato `NON_GATE_PASS` o `NON_GATE_FAIL`. Un PASS
richiede esattamente `160/160` azioni e `64/64` comande riuscite, cadenze nel
budget, concorrenza massima uno, otto sessioni preservate, zero errori e ledger
fisico byte-identico a `2/10`. In ogni caso gli otto Chrome contano `0` nel
gate.

Al 17 agosto 2026 esistono due risultati terminali immutabili
`NON_GATE_FAIL`: `26/160` azioni e `10/64` comande nel primo run, `83/160`
azioni e `33/64` comande nel secondo. Dopo le correzioni derivate dalle
diagnostiche, le suite mirate sono `54/54 PASS`, ma il workload completo non e
stato ancora rieseguito. Nessuno di questi risultati modifica B4, B5, B6 o il
49% ufficiale.

Avanzamento roadmap complessiva: **49%**
