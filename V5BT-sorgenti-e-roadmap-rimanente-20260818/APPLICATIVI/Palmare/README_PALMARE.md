# Palmare Advanced 1.0.22 - V5BT

Palmare Advanced e l'app Android autonoma della copia V5BT. Usa il package
`com.sentrapa.palmare.advanced`, distinto dalle app V4, quindi puo convivere
sullo stesso dispositivo senza sostituirle.

La build standard mantiene tutti i flag Bluetooth disabilitati. La variante
B3 Lab e esplicitamente nominata e richiede identita nativa pronta, permessi
BLE e classificazione `FULL_NODE`; in caso contrario radio e foreground type
`connectedDevice` restano spenti.

## Struttura

- `web-frontend/`: sorgente React/Vite mobile incorporato nell'APK.
- `android-app/`: shell Android, bridge NFC/PTT/notifiche e servizi in background.
- `tools/verify-device-webview.mjs`: verifica CDP della WebView su un device ADB.
- `build-palmare.ps1`: build ripetibile e installazione facoltativa.

Il frontend compilato viene sincronizzato da `web-frontend/dist` a
`android-app/app/src/main/assets/mobile` dal task Gradle `syncBundledWebApp`.
La WebView mantiene l'origin HTTPS del server configurato, ma intercetta solo
`/mobile` e serve quei file dall'APK. `/api`, SSE e WebSocket continuano invece
a raggiungere il backend sullo stesso origin. La UI resta quindi caricabile
anche quando il server non risponde, senza introdurre CORS diversi dalla webapp
ospitata.

## Offline

- Le risposte di lettura riuscite sono salvate in IndexedDB e riutilizzate in
  assenza del backend. La sessione ha una finestra cache di 12 ore; gli altri
  read model fino a 7 giorni.
- Le scritture ordinarie serializzabili sono conservate nell'outbox
  `palmare-offline-v1`, ricevono request ID e chiave di idempotenza e sono
  ritentate in ordine con backoff e timeout.
- La coda gia esistente di comande/layout resta proprietaria delle proprie
  route, evitando doppie code.
- Emissione e annullamento fiscale sono le sole operazioni critiche conservate
  per il replay automatico. Prima di ogni nuovo invio il backend verifica la
  chiave idempotente sul gateway fiscale autorevole e riconcilia l'esito.
- Pagamenti, stampa, fondo cassa, cambio, storni/resi, pausa, comandi monitor,
  radio e le altre operazioni critiche non vengono conservati in una coda
  manuale nascosta: in assenza del backend falliscono esplicitamente.
- Il banner mobile mostra soltanto lo stato offline e il numero di operazioni
  automatiche in coda. Il badge e la voce `Azioni`/`Da verificare` sono stati
  rimossi.
- All'avvio, eventuali vecchie operazioni fiscali `held` vengono migrate al
  replay automatico; le altre vecchie operazioni sospese vengono eliminate
  senza essere eseguite.
- Una risposta HTTP del backend non viene piu interpretata come assenza di rete
  per le operazioni critiche: in questo modo un errore applicativo non crea una
  seconda richiesta fiscale sospesa.

Una prima installazione senza server puo aprire la UI locale, ma non puo creare
una nuova sessione di login. Per lavorare autenticati offline serve almeno un
login online precedente e una risposta sessione ancora valida nella cache.

## Build

Prerequisiti: Node.js 20.19 o successivo, Android SDK 34 e JDK 17 o successivo.

```powershell
cd D:\cassav2\CASSAV4_V4.6_CURRENT\android\Palmare
.\build-palmare.ps1
```

Output verificati nella cartella `APPLICATIVI/Palmare`:

- standard corrente: `Palmare-Advanced-1.0.22-debug.apk`;
- laboratorio B3 V5BT:
  `Palmare-Advanced-1.0.22-V5BT-Bluetooth-B3-Lab-debug.apk`;
- laboratorio enrollment V5BT storico:
  `Palmare-Advanced-1.0.21-V5BT-Bluetooth-Lab-debug.apk`;
- laboratorio B2 storico: `Palmare-Advanced-1.0.20-B2-Lab-debug.apk`.

La standard `1.0.22` ha superato 130 test JVM, lint, verifica DEX dei flag
disabilitati e firma APK v2. SHA-256:
`ea5a8bcd852155d0cac75e80a7bae8e1b3e8e531b3f95ef9db91f3ebec569065`.

La variante B3 Lab abilita Lab, diagnostica, identita, discovery, enrollment,
failover e badge diagnostico read-only. `DirectServer` e `PeerLink` restano
falsi: non apre GATT e non crea sessioni. Usa l'endpoint enrollment TLS V5BT
congelato per il laboratorio. SHA-256:
`ce16f98d89a2da0dc44e0102cf83211694b2a422b8513b09ec628fde8b3446dc`.
Resta un artefatto non installato: i gate fisici B1/B2/B3 sono `PENDING`.

Le varianti Lab storiche restano disponibili per rollback delle rispettive
fasi. Tutte condividono il package Advanced della standard e quindi si
sostituiscono tra loro sul dispositivo; non sostituiscono l'app Palmare V4.

Per compilare e installare sul device collegato:

```powershell
.\build-palmare.ps1 -Install -DeviceSerial RFGYA0ZAGFW
```

L'URL backend iniziale e `https://192.168.0.28:5280/mobile/`. La
configurazione URL protetta gia presente nell'app aggiorna solo il server; la UI
continua a essere letta dal bundle locale.

## Base software

La build 1.0.12 e basata sulla workspace CASSAv4 v4.6 corrente. Il
confronto del sorgente mobile non ha rilevato file
mancanti in Palmare: le differenze sono le estensioni offline e le correzioni
native specifiche dell'app, che restano intenzionalmente locali.

## Batteria locale

- Android legge direttamente percentuale e stato di carica.
- La snapshot corrente e disponibile alla WebView tramite
  `window.AmaliaNativeBattery.getSnapshot()`.
- I cambiamenti arrivano con l'evento `amalia:native-battery`.
- Il frontend non interroga `/api/mobile/battery`, non apre stream SSE batteria
  e non esegue polling.
- Il servizio Android invia al monitor centrale una sola snapshot all'avvio e
  successivamente una ogni 60 secondi. I cambi di percentuale o carica non
  generano invii extra.

## Fix realtime notifiche 2026-07-14

L'APK `Palmare-1.0.5-debug.apk` incluso in questo pacchetto contiene il fix per la latenza di `Pronto` e `Chiama cameriere`. Il precedente APK è conservato come `Palmare-1.0.5-debug-originale-rollback.apk`.

Consultare `../../FIX_REALTIME_NOTIFICHE_20260714.md` e `../../INSTALLAZIONE_FIX_PALMARE.md` prima dell'installazione.

## Realtime nativo in background 2026-07-15

- Con UI non attiva, il servizio Android mantiene uno stream SSE diretto verso il backend per
  ricevere immediatamente chiamate e comande pronte senza polling continuo.
- Il pull notifiche viene eseguito solo all'apertura dello stream e dopo una disconnessione, per
  riconciliare eventuali eventi persi senza aumentare il carico periodico sul server.
- L'endpoint backend HTTP sulla porta `5281` viene provato prima del proxy HTTPS Vite. Sono stati
  rimossi il tentativo TLS non valido sulla porta backend e i relativi timeout a cascata.
- Quando la UI torna attiva, il trasporto nativo viene chiuso e la ricezione torna al solo stream
  posseduto dal frontend; il coordinatore nativo mantiene la deduplica per ID tra i trasporti.

## Allineamento frontend 2026-07-15

Il bundle locale e stato riallineato al frontend CASSAv4 attivo mantenendo il runtime offline e i
bridge Android specifici di Palmare. L'APK aggiornato e `Palmare-1.0.5-debug.apk` con SHA-256
`A933E388841968E1A2BBC7534ED16571C12F68CD5C1DD3D7AC11AAF8A42716A6`.

Il rollback immediatamente precedente e conservato in
`backups/Palmare-1.0.5-debug-before-frontend-sync-20260715-132225.apk`.

## Ripristino avviso postazioni 2026-07-15

- L'avviso del dettaglio tavolo mostra solo `NESSUNA POSTAZIONE ATTIVA`.
- Resta separato dagli errori generici e non dipende dalla chiusura del dettaglio.
- Scompare appena arriva un evento realtime di riattivazione; un controllo API ogni 3 secondi
  copre l'eventuale perdita dell'evento.
- Il layout tavolo usa subito il payload autenticato, evitando la precedente richiesta iniziale
  destinata a ricevere `401`.
- APK verificato: `Palmare-1.0.7-debug.apk`, SHA-256
  `B24B10E7BC936CFF669B06A8652521A1E8B44107CA2E006C7DC504A5F68AC529`.

## Allineamento v4.6 2026-07-16

- Il frontend incorporato e stato riallineato alla sorgente Mobile v4.6.
- Le estensioni offline Android e i relativi owner sono rimasti invariati.
- TypeScript, build Vite, test/lint/assemble Android e 27 test frontend mirati sono passati.
- APK: `Palmare-1.0.8-debug.apk`, SHA-256
  `E61F608CE366F004BA2925E71A250671DDD9D4472254352BABD0837D50D3F91C`.

## Compatibilita P5.4 2026-07-16

- Il bundle mobile resta allineato al frontend V4.6 corrente.
- Le modifiche P5.4 sono interne ai writer backend e non cambiano il contratto HTTP/SSE usato
  dall'app.
- La release `1.0.9` identifica la ricompilazione e la validazione contro lo stack P5.4.
- APK: `Palmare-1.0.9-debug.apk`, SHA-256
  `FD98D29EAA705AD3F446464B7EA7142FC094CCF32950E3A84E3C30FDB6B09A01`.

## Allineamento frontend corrente 2026-07-17

- Il frontend incorporato contiene tutti i file del Mobile V4.6 corrente.
- Restano intenzionalmente separati gli owner offline, la configurazione runtime e il client API
  adattato per la WebView.
- La release `1.0.10` identifica la nuova build Android con questi sorgenti.
- APK: `Palmare-1.0.10-debug.apk`, SHA-256
  `E4E13100BD23FFEE460DC55065B152C5A197DE96E44B540F7F470112907D9A93`.
- Installazione verificata su SM-A165F `RFGYA0ZAGFW`: `versionCode 11`, `versionName 1.0.10`.

## Correzione comande annullate 2026-07-17

- Il frontend locale riconosce `workflowStatus: cancelled` come stato terminale.
- Una comanda annullata resta consultabile nello storico ma non viene piu conteggiata come ordine
  attivo e non mantiene il tavolo nello stato `Ordine`.
- Lo storico mostra la dicitura `Annullata` e non propone azioni di modifica o reso.
- La release `1.0.11` incorpora la stessa correzione presente nel frontend Mobile V4.6 corrente.
- APK: `Palmare-1.0.11-debug.apk`, SHA-256
  `C36EBBD0CFABACC0B8E06D536871C261BB99DBA9916E9947B4B47A8C5EBDA02D`.
- Installazione verificata su SM-A165F `RFGYA0ZAGFW`: `versionCode 12`,
  `versionName 1.0.11`.

## Gestione operazioni da verificare 2026-07-17

- Il precedente badge `DA VERIFICARE` sopra la bottom bar e stato rimosso.
- Il numero di operazioni sospese, fallite o in conflitto compare in basso a
  destra sull'avatar.
- Quando il conteggio e maggiore di zero, il menu utente mostra `Azioni`
  immediatamente sotto `Pagamenti`, con lo stesso indicatore di attenzione.
- La modale `Azioni` descrive le operazioni in modo leggibile e consente
  esecuzione, rimozione o verifica in base al tipo di richiesta.
- Le richieste fiscali non possono essere eliminate o ritentate alla cieca:
  viene controllato prima lo stato corrente del pagamento; un'emissione
  forzata e disponibile solo per un admin autorizzato e quando lo stato non e
  pendente.
- La release Android associata e `1.0.12` (`versionCode 13`).
- APK: `Palmare-1.0.12-debug.apk`, SHA-256
  `1C12C9E765F3140D612D398351EA4B933AC46CB94483F4D0594BF8787D41504B`.
- Installazione verificata su SM-A165F `RFGYA0ZAGFW`: `versionCode 13`,
  `versionName 1.0.12`.

## Azioni fiscali separate nel dettaglio pagamento 2026-07-17

- Il long press di 2 secondi sul pulsante stampa seleziona soltanto
  `STAMPA AVANZATA`; non esiste piu una seconda soglia per l'emissione fiscale.
- Gli amministratori hanno un pulsante separato `EMETTI FISCALE` oppure
  `ANNULLA DOCUMENTO`, determinato dall'esito fiscale restituito dal backend.
- Dopo un annullamento, la ristampa usa il documento di annullamento mentre la
  stampa avanzata conserva anche il riferimento al documento fiscale originale.
- La release Android associata e `1.0.13` (`versionCode 14`).
- APK: `Palmare-1.0.13-debug.apk`, SHA-256
  `C308B042EFE3D614CC6FC9D9DEF5B06A2DDECEACEE8B7F945F1CA7B3314761AF`.
- Test unitari Android, lint e assemble superati.
- Installazione e verifica grafica ADB completate su SM-A165F
  `RFGYA0ZAGFW`: `versionCode 14`, `versionName 1.0.13`.

## Verifica fiscale autorevole 2026-07-17

- Il menu `Azioni` e ogni indicatore `Da verificare` sono stati rimossi.
- Emissioni e annullamenti fiscali sospesi vengono ripresi automaticamente con
  la stessa identita idempotente.
- Prima di ogni retry il backend interroga
  `POST /api/fiscal/receipt/verify`; solo un `NOT_FOUND` autorevole consente una
  nuova scrittura sul registratore.
- Le vecchie code manuali vengono migrate all'avvio senza eseguire operazioni
  critiche non fiscali.
- La release Android associata e `1.0.14` (`versionCode 15`).
- APK: `Palmare-1.0.14-debug.apk`, SHA-256
  `207D5A0921CC8083EB8177FB65F162EC0F120A98E197FF3541EABD86E9AE3CB6`.
- Test unitari Android, lint e assemble superati.

## Coda automatica invisibile 2026-07-17

- Il banner con conteggio `IN CODA` e pulsante `RIPROVA` e stato rimosso completamente.
- Il replay resta automatico e continua in background su avvio, ritorno online,
  riconnessione realtime, ritorno in primo piano e timer di sicurezza.
- Nessun conteggio o controllo della coda automatica viene mostrato all'operatore.
- La release Android associata e `1.0.15` (`versionCode 16`).
- APK: `Palmare-1.0.15-debug.apk`, SHA-256
  `ECCE2C4B591CF1E57909D8DCF4D9FEF1AC1015D96A4E0F4C7D7B14C1164DEDB4`.
- Test frontend mirati, TypeScript, build Vite, test unitari Android, lint e
  assemble sono stati completati con esito positivo.
- Installazione e verifica grafica ADB completate su SM-A165F
  `RFGYA0ZAGFW`: `versionCode 16`, `versionName 1.0.15`.

## Movimenti cassa e azioni fiscali 2026-07-17

- La pressione prolungata su `STATISTICHE` espone `PAGAMENTI`, `MOVIMENTI` e
  `FONDI CASSA`.
- La vista movimenti include caricamenti, prelievi e cambi con dettaglio,
  giustificazione e stato persistito dal backend.
- La pagina pagamenti espone i flussi guidati `CARICAMENTO` e `PRELIEVO`.
- I badge contanti e carta usano icone e colori distinti in tema chiaro e
  scuro.
- `EMETTI FISCALE` usa l'icona ufficiale incorporata nel frontend.
- La pressione lunga seleziona la stampa avanzata mantenendo la label
  `STAMPA`; il pulsante resta giallo durante l'invio e torna verde al termine.
- La release Android associata e `1.0.16` (`versionCode 17`).
- APK: `Palmare-1.0.16-debug.apk`, SHA-256
  `CC29B4536D889F155D098576C25A8173B60865FB304104610AD3C66DB4A335F1`.
- Test frontend mirati, TypeScript, build Vite, test unitari Android, lint e
  assemble completati con esito positivo.
- Installazione e avvio verificati su SM-A165F `RFGYA0ZAGFW`.
- APK: `Palmare-1.0.16-debug.apk`, SHA-256
  `4815410159F468EFCF5649CA1DEC5C9E6F6F5342756D5DA1EDB4D88CC65A706F`.
- Test frontend mirati, typecheck, build Vite, test unitari Android, lint e
  assemble completati con esito positivo.

## Audio e stabilita UI 2026-07-19

- Il player radio usa un jitter buffer da 120 ms, una soglia di rebuffer da
  160 ms e una breve continuita con rientro sfumato per assorbire ritardi
  intermittenti senza scatti o click.
- La modalita best-seller mantiene `Varie` al primo posto, porta subito sotto
  fino a 7 articoli classificati e lascia visibili tutti gli altri, sia in
  `Nuova Comanda` sia in `Ordine Banco`.
- La rimozione di un articolo dalla comanda non applica piu l'animazione di
  riassetto alle righe rimaste.
- Ogni URL server esplicitamente configurato viene conservato senza migrazioni
  automatiche durante l'aggiornamento dell'app.
- La release Android associata e `1.0.17` (`versionCode 18`).
- APK: `Palmare-1.0.17-audio-ui-stable-20260719-debug.apk`, SHA-256
  `0B25CD143567D4B308DA57B778AAB8C4A205DE1B55349A971E7147B19290468E`.
