# CASSAv4 - Handover continuazione 2026-07-13

## Sorgente autorevole

La versione corrente da usare e:

```text
sistema-cassa-refactor-p4-p7-20260713-source/
```

Non ripartire da cartelle `old`, backup o ZIP precedenti. Il checkout ricevuto
non contiene una storia Git utilizzabile: la continuita va verificata tramite
manifest, checksum e test inclusi nel pacchetto.

## Contenuto

La radice autorevole contiene:

- backend e frontend cassa in `cassa-frontend/`;
- frontend mobile in `mobile-frontend/`;
- frontend postazione in `postazione/`;
- dashboard batteria in `battery-dashboard/`;
- frontend impostazioni, prenotazioni e monitor;
- script di avvio, strumenti operativi, documentazione e prove P4-P7.

Il pacchetto di continuazione aggiunge, come componenti separati:

- sorgente Android WebView in `companion/android-webview-app-source/`;
- progetto Palmare Android e frontend offline in `companion/Palmare/`;
- APK disponibili in `apk/`.

Dipendenze installate, database runtime, log, screenshot, certificati, chiavi,
CA e configurazioni locali non sono inclusi.

## Stato corrente

- avanzamento complessivo roadmap A-P: circa 84%;
- P3: chiusa;
- P4: circa 55%, corretta funzionalmente ma con gate load-100 ancora rosso;
- P5 endurance: non eseguita per 90 minuti;
- P6 chaos: non eseguita come campagna completa;
- P7: non avviata, bloccata da P4-P6.

La roadmap aggiornata e:

```text
cassa-frontend/ROADMAP_COMPLETAMENTO_P4_P7_20260713.md
```

## Ultimo step completato

E stato chiuso l'audit P4.3 di `POST /api/pos/room-change/approve`:

- corretta la write dirty aggiungendo il dominio `users`, necessario per
  persistere `lastSelectedRoom*`;
- aggiunti guard architetturali sul confine SQLite/MySQL;
- decisione `NO-GO` per un falso writer atomico cross-store;
- nessun nuovo fast path o flag promosso.

Dettagli:

```text
cassa-frontend/FASE_P4_3_ROOM_CHANGE_APPROVE_ATOMIC_WRITER_AUDIT_20260713.md
```

Il writer atomico richiederebbe prima la migrazione della pending allo stesso
MySQL InnoDB di sessione e utente e repository connection-bound. Nel modello
attuale i commit SQLite e MySQL restano separati.

## Ultima validazione

Eseguita il 2026-07-13:

- `node --check backend/server.js`: superato;
- `route-policy-architecture.test.mjs`: 135/135;
- E2E room-change e PIN pre-lane: 7/7;
- `npm run test:backend:release`: superato;
- test stampa fast-worker MySQL: saltato per MySQL locale non disponibile;
- `npm run test:backend`: non concluso entro 15 minuti sui 220 file, quindi
  non va registrato come superato; nessun processo residuo dopo il timeout.

## Prossimo task

Proseguire P4.3 con `waiter pause/start/stop`:

1. mappare route, lane, owner durevole e fan-out notifiche;
2. misurare separatamente lane wait, run, write e publish/delivery;
3. verificare idempotenza, recovery e concorrenza sullo stesso cameriere;
4. introdurre un fast path solo se conserva un owner durevole e un rollback
   singolo;
5. eseguire test mirati e canary 20/50 prima di qualunque load-100.

Non estendere il fast path table-room-move a status/resolve.

## Preparazione su un altro PC

Prerequisiti minimi: Node.js compatibile con il lockfile, npm, Java/Android SDK
solo per ricompilare le app Android, oltre ai servizi MySQL/Redis/MQTT previsti
dal profilo scelto.

Verifica sorgente web/backend:

```powershell
cd .\source\sistema-cassa-refactor-p4-p7-20260713-source\cassa-frontend
npm ci --no-audit --no-fund
npm run check:backend
npm run test:backend:release
node scripts\package-preflight.mjs --package --root ..
```

Frontend mobile:

```powershell
cd ..\mobile-frontend
npm ci --no-audit --no-fund
npm run test
npm run build
```

Le configurazioni di produzione, i certificati HTTPS LAN e i segreti devono
essere ripristinati separatamente sulla macchina target. Non usare valori di
sviluppo come segreti di produzione.

## Integrita del pacchetto

Alla radice dello ZIP sono presenti:

- `PACKAGE_INFO.json`;
- `PACKAGE_MANIFEST.tsv`;
- `CHECKSUMS_SHA256.txt`;
- questo handover come `LEGGIMI_PRIMA.md`.

I file `BUILD_INFO.json`, `MANIFEST.txt` e `SHA256SUMS` eventualmente presenti
dentro la cartella `source/` documentano lo snapshot ricevuto in origine. Per
verificare questo handover aggiornato fanno fede i manifest alla radice dello
ZIP e il checksum esterno dell'archivio.

Accanto allo ZIP viene creato un file `.sha256` con l'hash dell'archivio.
