# CASSAv6 — Handover, 4 settembre 2026

Questo file sta in piedi da solo: chi lo legge non ha visto niente di quello che
e' successo prima. Racconta **cos'e' il sistema, dov'e' arrivato, cosa gira
davvero in esercizio, cosa e' stato corretto e perche'**, e soprattutto le
trappole gia' pagate, che sono la parte che fa perdere piu' tempo a chi
ricomincia.

Il file precedente, `HANDOVER_IA_STATO_20260903.md`, resta come **registro
storico**: i dettagli lunghi della decomposizione di `server.js` (§6, §10, §19)
sono li' e non vengono ripetuti qui. Dove serve, e' citato.

---

## 1. Il sistema in due minuti

CASSAv6 e' un registratore di cassa per ristorazione: sala, comande, postazioni
di preparazione, pagamenti, documenti fiscali.

**Quattro applicativi**, un solo backend:

| pezzo | cos'e' | dove |
|---|---|---|
| backend | Node.js, monolite in decomposizione | `SORGENTE_SISTEMA/cassa-frontend/backend` |
| webapp cassa/sala | React + Vite, e' quella che si usa in sala | `SORGENTE_SISTEMA/mobile-frontend` |
| webapp palmare | la stessa, con divergenze **volute** | `APPLICATIVI/Palmare/web-frontend` |
| Postazione | schermo di bar/cucina | servita da `/postazione/` |
| app Android | kiosk che carica la webapp dagli asset dell'APK | `APPLICATIVI/Palmare/android-app` |

**Persistenza**: MariaDB (`cassa_v5bt`). PostgreSQL e' **preparato ma non
acceso**: `database.mode: "mysql"`, `postgresql.enabled: false`. Nessuno ha
ancora premuto quell'interruttore.

### I due alberi del frontend

`mobile-frontend` e `web-frontend` del palmare sono **due copie che divergono di
proposito**. Oggi divergono, per esempio, di 122 righe in `TablesWorkspace.tsx` e
di 14 in `TableDetailPanel.tsx`.

> **Regola**: ogni modifica al frontend va applicata **a entrambi**, e va
> verificato con `diff` che i file toccati siano rimasti allineati sulle righe
> nuove. Non si "risolvono" le divergenze copiando un albero sull'altro: sono
> volute.

---

## 2. L'ambiente

### Il Raspberry di sviluppo

- indirizzo **192.168.0.67**, utente `admin` (le credenziali sono quelle date dal
  proprietario e stanno in uno scratch fuori dal repository);
- **5380**: i frontend, in **HTTPS** con certificato self-signed
  (`serve-frontends.mjs`); `/mobile/`, `/postazione/`;
- **5381**: le API, in HTTP;
- servizio systemd **`cassav5bt.service`**; radice
  `/home/admin/cassav5bt-current/cassa V5BT/`;
- la webapp e' servita da `SORGENTE_SISTEMA/mobile-frontend/dist`: si consegna
  costruendo in locale e caricando quella cartella.

**Attenzione a `config.json`**: sta **dentro** `dist`, quindi una consegna lo
sovrascrive. Va confrontato con quello in esercizio prima di sostituire la
cartella (finora e' sempre risultato identico, ma e' un colpo da non correre).

### Il palmare

App kiosk Android. La UI arriva dagli **asset dell'APK**, le `/api` dalla rete:
una correzione al `web-frontend` del palmare **non arriva sul dispositivo finche'
non si ricostruisce l'APK**. Il PIN di configurazione dell'URL e' **l'orario
corrente** in formato `HHmm`; sblocco con pressione lunga di 5 secondi, finestra
di 10 secondi.

**Come si ricostruisce**: `APPLICATIVI/Palmare/build-palmare.ps1`. Fa `npm ci` e
`npm run build` nel `web-frontend`, imposta la JBR di Android Studio come
`JAVA_HOME` (Java 25 rompe il compilatore Kotlin) e l'SDK, poi
`gradlew testDebugUnitTest lintDebug assembleDebug`. L'APK finisce in
`APPLICATIVI/Palmare/Palmare-Advanced-<versione>-debug.apk`.

Il task Gradle `syncBundledWebApp` copia il `dist` dentro gli asset e **fallisce
apposta** se un sorgente web e' piu' recente del bundle: e' cio' che impedisce di
consegnare un APK con dentro una webapp vecchia.

**Tre dispositivi identici (SM-A165F) sono collegati via ADB** e vanno distinti
prima di installare, perche' puntano a server diversi:

| seriale | server configurato |
|---|---|
| `R58YA1578XB` | **192.168.0.67** — il Raspberry di sviluppo: e' questo il palmare in uso |
| `R58YA13TLFN` | 192.168.0.28 |
| `R5GYB42PASH` | 192.168.1.159 |

Si distinguono leggendo le preferenze:
`adb -s <seriale> shell run-as com.sentrapa.palmare.advanced cat shared_prefs/webkiosk_prefs.xml`.
Si installa con `adb -s <seriale> install -r -g <apk>`: `-r` aggiorna conservando
i dati, quindi **l'URL salvato sopravvive** — verificato rileggendo le preferenze
dopo l'aggiornamento.

---

### Il tablet della Postazione

`SM-T503`, Android 12 (API 31), seriale `R9WT50ZN5VZ`. Ha **quattro** app
Postazione affiancate; quella in uso e' `com.sentrapa.postazione.advanced.partial`.
Come il palmare, **incorpora** la sua webapp negli asset: una correzione al
frontend non arriva finche' non si ricostruisce.

Tre cose scoperte ricostruendola, tutte bloccanti:

1. **il progetto non si costruiva affatto.** Sotto `com/sentrapa/cassav6/**` c'e'
   una seconda copia dell'app che non compila (usa `BuildConfig` e `R` di quel
   package, mentre il namespace del modulo e' `com.sentrapa.webkiosk`). Il
   progetto Palmare la esclude dalla compilazione; **quello Postazione no**. E'
   stata aggiunta la stessa esclusione;
2. **la variante `api31Compat` non e' costruibile senza provisioning**: pretende
   `cassaApi31CompatEnrollmentEndpointId`, un URL HTTPS `/v2/enroll` e un pin
   SPKI canonico, che sono segreti di provisioning Bluetooth. Si costruisce
   invece la variante **`partial`**, che ha lo **stesso applicationId**
   (`...advanced.partial`) e quindi aggiorna la stessa installazione;
3. **un test contrattuale fissa l'indirizzo predefinito** a
   `https://192.168.1.79:5380/postazione/`: passare
   `-PcassaPartialDefaultServerUrl` diverso lo fa fallire. Si costruisce senza
   quella proprieta' e si punta il tablet dalle preferenze.

Comando che funziona:

```
gradlew :app:testPartialUnitTest :app:lintPartial :app:assemblePartial
```

L'APK esce in `app/build/outputs/apk/partial/app-partial.apk`.

> La firma della `partial` **non coincide** con quella della `api31Compat` gia'
> installata: l'aggiornamento e' stato rifiutato e ha richiesto una
> disinstallazione, quindi la configurazione e' andata persa e l'URL e' stato
> riscritto a mano. Da mettere in conto.

### Pilotare i dispositivi: CDP, non i tap a coordinate

Le WebView dei dispositivi sono ispezionabili: si aggancia Playwright via
`connectOverCDP` e si usano i selettori veri invece di `input tap x y`.

```bash
adb -s <seriale> shell pidof <package>              # il PID del processo giusto
adb -s <seriale> forward tcp:<porta> localabstract:webview_devtools_remote_<pid>
```

Poi `chromium.connectOverCDP("http://127.0.0.1:<porta>")`.

Due trappole pagate:

- il socket **va agganciato al PID del pacchetto**. Cercare il primo
  `webview_devtools_remote_*` con `head -1` prende la WebView di **un'altra**
  app: su questi dispositivi ce ne sono tre o quattro affiancate, e si finisce a
  guardare la pagina sbagliata;
- `adb forward --remove-all` e' **globale**, non per dispositivo, anche con
  `-s`: dentro un ciclo ogni giro cancella gli inoltri dei precedenti.

E una del guscio: in PowerShell le variabili non distinguono maiuscole e
minuscole, quindi `$S` e `$s` sono **la stessa variabile**. Un ciclo
`foreach ($s in ...)` sovrascrive la cartella tenuta in `$S`.

## 3. Migrazione PostgreSQL, fase P2b

Obiettivo di P2b: **nessuna `readDb()`/`writeDb()` diretta nel corpo degli
handler**, contate a profondita' 0. Il criterio non e' "il numero cala", e'
**"lo stato applicativo ha un proprietario"**.

**Otto domini chiusi a 0/0**: identity, configuration, catalog, commerce, audit,
messaging, `app_meta`, fiscal — **63 route su 198**.

Modelli estratti (tutti in `backend/modules/**`): `audit-read-model` /
`audit-write-model`, `messaging-model` (766 righe, handler da 768 a 84),
`monitor-projection`, `app-meta-model`, `monitor-control-model` (937 righe,
`status.handlers.js` da 1.784 a 300), `app-state-model`, `fiscal-model`,
`payments-fiscal-model` (955 righe).

Lo stato ufficiale e' in
`ROADMAP_V6/POSTGRESQL/V6_POSTGRESQL_MIGRATION_ROADMAP_REV2/MIGRATION_STATUS.md`.

### Le tre classi di dipendenza persa

Spostare codice dagli handler ai modelli fa perdere dipendenze in **tre** modi, e
servono strumenti diversi per ciascuno:

1. **un nome che nessuno inietta**, che da' `ReferenceError` e quindi 500. Lo
   trova l'analizzatore delle variabili libere;
2. **un nome dichiarato fra i parametri della factory e mai passato**, che arriva
   `undefined` e da' "is not a function". Serve un **secondo** analizzatore: il
   primo non lo vede;
3. **un rinomino al punto di chiamata perso copiando le dipendenze per nome di
   chiave** (`appEnv: APP_ENV`, `getRuntimeFeatureProfile: getP43RuntimeFeatureProfile`,
   `debugEnabled: ENABLE_DEBUG_ENDPOINTS`), che da' `ReferenceError`
   **all'avvio**. **Nessun analizzatore lo vede.** L'ha preso solo un test che
   avvia davvero il backend.

> Morale: le dipendenze **non si copiano per nome**, si riusano le righe esatte
> della chiamata esistente.

---

## 4. Cosa gira davvero sul Raspberry

Questa e' la sezione che si dimentica e che poi costa mezza giornata.

| pezzo | in esercizio sul Pi | note |
|---|---|---|
| webapp `mobile-frontend` | **si', build del 4 settembre** | `assets/index-icSS-ZOB.js` |
| `room-change.handlers.js` | **si'**, consegnato da solo | il file sul Pi era identico byte per byte alla versione locale precedente, quindi la consegna e' esattamente quella differenza |
| fette `messaging`, `app_meta`, `fiscal` | **si'**, consegnate il 4 settembre | 17 file (7 nuovi, 10 modificati) piu' la guardia sui coperti; copia di sicurezza `backend.baseline-20260904-174846` |
| APK del palmare | **si'**, `Palmare-Advanced-1.0.39-debug.apk` del 4 settembre | installato su **tutti e tre** i palmari |
| APK della Postazione | **si'**, `Postazione-Advanced-2.0.23-partial-debug.apk` | installato sul tablet `R9WT50ZN5VZ` |

Il delta del backend si misura cosi', ed e' il modo per sapere davvero cosa manca
sul Pi senza fidarsi della memoria:

```bash
# in locale e sul Pi, poi si confrontano i due elenchi
find backend -type f -name '*.js' -not -path '*/node_modules/*' | sort | xargs sha256sum
```

Attenzione: `sha256sum` su Windows antepone `*` al nome del file. Senza toglierlo
il confronto non aggancia niente e sembra che **tutto** sia diverso.

**Copie di sicurezza pronte sul Pi**:

- `backend.baseline-20260904-025821` — il backend intero;
- `.../pos-rooms/room-change.handlers.js.baseline-20260904-151123`;
- `.../mobile-frontend-dist.baseline-20260904-145255` e `-20260904-160813`.

Riavvio: `sudo systemctl restart cassav5bt.service`, poi si controlla
`systemctl is-active` e due `curl` (5380 e 5381) prima di dire che e' fatto.

---

## 5. I difetti chiusi, e perche' esistevano

### 5.1 «Se faccio troppo velocemente non me lo segna» — tre difetti, non uno

Segnalazione dall'esercizio: un'intolleranza segnata in fretta su un tavolo non
veniva registrata. Dietro c'erano **tre** difetti indipendenti, tutti silenziosi:
la scelta spariva senza un messaggio.

**1. Le intolleranze non erano nel confronto del salvataggio automatico.**
`useAnagraphicAutoSave` decideva se salvare guardando nome, telefono, coperti e
nota. Allergeni e intolleranza manuale non c'erano. Su un tavolo che aveva
**gia'** il marcatore `ALLERGIE / INTOLLERANZE` in nota, aggiungerne una seconda
non muoveva nessuno dei campi guardati: il salvataggio **non partiva mai**, per
quanto si aspettasse. E' questo il "spesso" della segnalazione — dipendeva da
cosa il tavolo avesse gia'.

**2. Il rinvio di 900 ms veniva annullato invece che eseguito.** Quando la nota
cambia davvero (prima intolleranza segnata, ultima tolta) il salvataggio parte
900 ms dopo. Chiudere il dettaglio o cambiare tavolo prima faceva scattare la
pulizia dell'effetto, che azzerava il timer. E' il "troppo velocemente". Ora un
salvataggio ancora in attesa viene **eseguito** alla chiusura del pannello o al
cambio di tavolo.

**3. Lato server, un campo vuoto non voleva dire "cancella".** In
`handleIntegrationLayoutTableSync` la regola era "se l'elenco richiesto ha
elementi usa quello, altrimenti tieni quello salvato", e la stessa forma valeva
per l'intolleranza manuale e per la nota: **le intolleranze non si potevano piu'
togliere** se non liberando il tavolo, e la modale di conferma cancellazione
sembrava funzionare ma al ricarico le pastiglie tornavano tutte. Ora si distingue
il campo **assente** — che continua a valere "non toccare", ed e' cio' che
protegge un tavolo da un client che sincronizza senza conoscere l'anagrafica —
dal campo **presente e vuoto**, che cancella.

Il terzo e' emerso **solo** perche' una verifica partiva da uno stato sporco e
l'azzeramento non riusciva. Senza quel passaggio sarebbe rimasto nascosto dietro
al primo.

**Non e' un difetto**: il testo scritto nel campo manuale e non aggiunto con il
tasto `+` resta fuori dalla conferma. E' voluto: il `+` e' il gesto con cui quel
campo si conferma.

### 5.2 La risincronizzazione cancellava le modifiche aperte

Restava una finestra dichiarata: l'effetto di `TablesWorkspace` che riallinea il
modulo ai dati del server riscriveva **tutti** i campi a ogni cambio di
`detailTableFormSyncKey`, senza guardare se c'era qualcosa in sospeso. Un
aggiornamento che arrivava fra la scelta e il salvataggio la cancellava.

Regola nuova, in `shouldReseedTableForm` (`tables/utils.ts`, funzione pura cosi'
si prova senza montare la workspace):

- **cambio tavolo** significa risincronizzare **sempre** (li' la bozza appartiene
  a un altro tavolo, trascinarla sarebbe peggio);
- **stesso tavolo con modifiche in sospeso** significa non toccare niente;
- **stesso tavolo senza niente in sospeso** significa risincronizzare.

Il segnale e' `tableMetaHasChanges`, letto da un `useRef` aggiornato da un
effetto senza dipendenze (lo stesso modello di `saveRef`). **L'ordine dei due
effetti conta ed e' quello giusto**: l'effetto di risincronizzazione e'
dichiarato prima, quindi legge il valore del commit precedente — cioe' se le
modifiche c'erano **prima** che arrivasse l'aggiornamento, che e' la domanda.

> **Conseguenza da conoscere**: se due dispositivi lavorano sullo stesso tavolo,
> chi ha una bozza aperta non vede piu' arrivare la modifica dell'altro finche'
> non salva. E' il comportamento chiesto e coincide con
> l'ultimo-che-scrive-vince gia' in atto, ma va detto.

### 5.3 Le tessere dei tavoli

- **la durata e' ancorata al bordo destro** della testata e ha **misura fissa di
  74px** — l'etichetta piu' larga possibile e' `23h 59min`, misurata a video in
  72,93px. Cosi' non cambia larghezza passando da `45min` a `3h 20min` e non
  trascina con se' i coperti;
- **i coperti stanno attaccati alla sua sinistra**, a 4px (il gap della testata).
  Se la pastiglia coperti manca, l'aggancio si sposta sulla durata e questa resta
  comunque a destra;
- la durata dei **tavoli liberi** (l'orario della prenotazione) non ha la classe
  `is-primary` e non entra in queste regole: li' a destra ci va il badge delle
  intolleranze;
- **filigrana** dello stato (`ACCOMODATO`, `ORDINE`, `PAGARE`, `LIBERO`):
  opacita' da 0,22 a **0,30**.

### 5.4 Durate lunghe

Prima l'unita' massima era l'ora, dichiarata nel commento e fissata da un test.
Un tavolo aperto da giorni mostrava un numero di ore illeggibile. Ora sono **due
progressioni**, perche' la tessera ha meno spazio del dettaglio:

| trascorso | tessera | dettaglio |
|---|---|---|
| meno di 60 min | `45min` | `45min` |
| meno di 24 h | `3h 20min` | `3h 20min` |
| da 24 h a 30 giorni | `2g 5h` | `2g 5h 20min` |
| da 30 a 365 giorni | `41g` | `41g 5h` |
| oltre 365 giorni | `380g` | `380g` |

`formatElapsedCompact` **ha tenuto il nome** ed e' quella del dettaglio: e'
citata testualmente da un test statico. La nuova, per le tessere, e'
`formatElapsedCoarse`. I componenti a zero non si scrivono (`2g`, non `2g 0h`).

---

### 5.5 «Sui tavoli a due cifre non vedo i coperti»

Sembrava un difetto della testata introdotto dalla larghezza fissa. **Non lo
era**: misurando la tessera, la pastiglia dei coperti risultava **assente dal
DOM**, non compressa, e la testata non andava in overflow.

La pastiglia si mostra solo con `covers > 0`. Quei tavoli avevano **zero
coperti**. La prova: mettendo 4 coperti al Tavolo 13 (due cifre) la pastiglia
compare a 29,13px accanto alla durata, con la durata ancora a filo del bordo
destro e nessun troncamento. La correlazione con le due cifre era una
coincidenza di come quel fondo di prova era stato creato.

Il difetto vero e' a monte, in `handleIntegrationLayoutTableSync`:

```js
// prima
const nextCovers = isRelease
  ? 0
  : (requestedCovers ?? normalizeTableCovers(current.covers, { minimum: 1, fallback: 1 }));
```

Il campo **assente** aveva gia' il minimo a 1; un `covers: 0` **esplicito** no, e
passava. Da li' vengono i tavoli occupati con zero coperti. Ora il minimo vale in
entrambi i casi, e resta zero solo liberando il tavolo. Due casi lo fissano in
`table-sync-intolerance-clear.e2e.test.mjs`.

> **Resta da sapere**: le righe gia' salvate con zero coperti restano a zero
> finche' qualcuno non le tocca. La guardia impedisce di crearne di nuove, non
> riscrive il passato.

### 5.6 «Sul tablet non vedo nessun cameriere»

Anche questo sembrava un'app vecchia, e anche questo non lo era.

L'elenco `CHIAMA CAMERIERI` della Postazione (`postazione/src/App.jsx`, intorno
a riga 1750) filtra tre volte: solo `clientApp === "mobile-frontend"`, solo chi
e' `online && activeNow`, e **esclude se stessi** per userId, username e nome
completo. Giustamente: non ci si chiama da soli.

Nella simulazione avevo collegato **tutti** — tre palmari e Postazione — come
`lorenzo`, quindi ogni cameriere veniva scartato come "se stesso" e la lista
restava vuota. Assegnando un operatore diverso a ciascun palmare la Postazione
elenca correttamente Francesca, Giada e Roberto con la loro sala.

**Gli utenti configurati sul Pi** sono `amalia` e `lorenzo` (admin), `francesca`,
`giada` e `roberto` (operatori); in sviluppo condividono il PIN `1234`. Si
leggono con:

```
POST /api/settings/pos/users
  header  X-Client-App: postazione
  corpo   { token, userId, deviceUuid, clientApp: "mobile-frontend" }
```

Con `clientApp: "cassa-frontend"` la stessa rotta risponde **401**.

## 6. La rete di test

### Aggiunta in questi due giorni

| file | casi | cosa fissa |
|---|---|---|
| `mobile-frontend/tests/anagraphicAutoSaveIntolerances.test.tsx` | 7 | la seconda intolleranza con la nota ferma, la chiusura prima dei 900 ms, il cambio tavolo, e i due casi che impediscono di salvare **di troppo** |
| `mobile-frontend/tests/elapsedDuration.test.ts` | 9 | le due progressioni ai confini: 24 ore esatte, 30 giorni, un anno |
| `mobile-frontend/tests/tableFormReseed.test.ts` | 4 | quando il modulo si risincronizza, **e quando no** |
| `cassa-frontend/backend/tests/table-sync-intolerance-clear.e2e.test.mjs` | 5 | vuoto significa cancella, assente significa non toccare, si toglie **una sola** intolleranza lasciando le altre; e i due sui coperti: un tavolo che non si libera ne conserva almeno uno, liberandolo tornano a zero |
| `backend/tests/app-meta.e2e.test.mjs`, `audit-domain.e2e.test.mjs` | 6 e oltre | vedi handover del 3 settembre |

Tutti i test frontend esistono **in entrambi gli alberi**.

Due di questi non sono decorativi: **sul codice precedente 2 dei 3 casi backend
sono rossi**, e il caso `reset_all_tables` di `app-meta` esiste perche' la sua
assenza aveva nascosto un 500 su quel solo ramo.

### La suite Android

`gradlew testDebugUnitTest` esegue **386 casi** e fa parte della build dell'APK:
se uno e' rosso, **l'APK non viene prodotto**. Nessun gate del frontend la
guarda, quindi un cambiamento in Kotlin puo' restare rotto finche' qualcuno non
ricostruisce.

E' successo davvero: `PalmareWebAppAssetsTest.usesTheCurrentServerAsDefault`
fissava `DEFAULT_SERVER_URL` sull'indirizzo vecchio ed e' rimasto rosso dal 3
settembre — quando il predefinito e' stato spostato sul Raspberry attuale —
fino al 4, cioe' fino alla prima ricostruzione dell'APK.

Anche qui il test e' stato **riscritto** e non aggirato. Insieme e' stato
sostituito `migratesThePreviousDotZeroDefaultToTheCurrentServer`, che confrontava
l'indirizzo attuale con un default identico e quindi **passava senza provare
niente**: al suo posto c'e' `neverTreatsTheCurrentServerAsDismissed`, che passa
un default **diverso** e cosi' fallirebbe davvero se l'indirizzo del server in
uso tornasse nella lista degli indirizzi dismessi — che e' esattamente il difetto
del palmare descritto in §8.

> Sotto `com/sentrapa/cassav6/**` c'e' una seconda copia dell'app, **esclusa
> dalla compilazione** in attesa della migrazione di identita' V6. E' coerente
> con i propri sorgenti (porta 5480, altro predefinito) e **non** va allineata a
> quella in uso.

### Un test statico riscritto, non aggirato

`tests/static/tableFreeAction.test.ts` fissava la regola opposta a quella nuova:
diceva, con un commento esplicito, che un tavolo si misura in ore e minuti e mai
in giorni, e lo faceva rispettare con un'asserzione che vietava l'unita' `g`.

Quella regola e' stata cambiata **deliberatamente**, quindi l'asserzione e il suo
commento sono stati sostituiti con la regola nuova. La tentazione, quando un test
statico si mette di traverso, e' cancellarlo: non va fatto, va riscritto per dire
la verita' nuova. (Nel palmare quel file e' una versione piu' vecchia che quel
blocco non ce l'ha: li' non c'era niente da riscrivere.)

### I rossi preesistenti, da non confondere con regressioni

- **`mobile-frontend`: 3** — `architectureRules` (budget di righe),
  `paymentsAutomaticCashUi`, `tableDetailReservationManager`. Su 667 casi;
- **`web-frontend` del palmare: 11**, su 630 casi.

Nessuno di questi e' stato introdotto in questi due giorni; e' stato verificato
rimettendo gli originali e rieseguendo.

**Il budget di righe di `architectureRules` va guardato**: gli sforamenti attuali
sono 6 file, tutti preesistenti. Il 3 settembre `TableDetailPanel.tsx` ci era
entrato per una modifica mia (1532 contro un tetto di 1529) ed e' stato riportato
dentro (1525) riscrivendo una chiamata su una riga invece che su sette. Se un
file **nuovo** compare in quell'elenco, e' una regressione.

### I gate

`npm run gate:architecture-security` (198 route, 0 violazioni),
`npm run gate:migration:pg:p2b-baseline`, `npm run migration:pg:p2b-routes`
(`unresolvedRouteCount: 0`), `npm run test:migration:pg:p2b-routes`.

> Il gate della baseline **non copre** la suite backend (307 file). Va eseguita a
> parte.

---

## 7. Trappole gia' pagate

Ognuna di queste e' costata tempo almeno una volta.

**Scrittura di file e script**

- gli **heredoc di bash** mangiano le sequenze di escape se il delimitatore non
  e' fra apici; e anche con gli apici, un contenuto che mescola backtick e
  espressioni regolari puo' far fallire l'analisi della riga di comando. Per un
  documento lungo conviene scrivere il file con uno strumento di scrittura
  diretto invece che con un heredoc;
- i **backtick** dentro `python -c` annidato in bash diventano sostituzione di
  comando: hanno cancellato nomi di file da una riga di documentazione;
- **fine riga miste**: `backend/server.js` e' LF, `backend/modules/**` e' CRLF.
  Uno script che ricava la fine riga da un file e la applica a un altro non trova
  niente e fallisce in modo poco chiaro. Va tenuta una variabile per file;
- **path MSYS**: un percorso come `/home/admin/...` viene riscritto in
  `C:/Program Files/Git/home/admin/...`. Si e' presentato come un ENOENT
  incomprensibile di paramiko: si risolve usando percorsi **relativi** in SFTP.

**Codice**

- `node --check backend/server.js` **non controlla i moduli**: un errore di
  sintassi in `payments.handlers.js` e' passato liscio;
- l'operatore `??` ricade solo su `null` e `undefined`, quindi un array vuoto
  passa: e' cio' che rende corretta la distinzione fra campo assente e campo
  vuoto;
- una **funzione dichiarata a colonna zero** puo' essere comunque dentro una
  factory: in `payments.handlers.js` lo sono. Uno script che cerca le funzioni
  rientrate non le trova.

**Prove a video (Playwright)**

- `hasText` con un'espressione regolare e' **sensibile alle maiuscole**: cercare
  `PAGARE` fallisce perche' nel DOM c'e' "Pagare" e il maiuscolo e' solo CSS;
- il **profilo persistente** (`launchPersistentContext`) tiene la sessione fra
  un'esecuzione e l'altra: comodo, ma significa che una prova puo' partire da uno
  stato sporco lasciato dalla precedente. **Una prova deve azzerare e verificare
  l'azzeramento contro il server**, altrimenti un confronto per contenuto passa
  per caso;
- al ricarico la webapp **puo' riaprire da sola il dettaglio** dov'era: la
  piastrella resta dietro allo sfondo e non va cliccata;
- sulla **Postazione**, "Accedi" non e' un click ma una **pressione di 2
  secondi**; poi chiede quale postazione (BAR-1 oppure BAR-2);
- **senza una postazione collegata la cassa rifiuta le comande**
  (`mobile-no-active-stations-backdrop`): e' il sistema che funziona, non un
  difetto;
- con il realtime connesso **il client non fa polling**: un cambio fatto via API
  non rientra da solo mentre il dettaglio e' aperto. Per farlo rientrare si usa
  un **lampo di rete** (`context.setOffline(true)` e poi `false`), che e' anche
  il modo in cui succede in sala.

**Android**

- **Java 25 rompe il compilatore Kotlin**: si usa la JBR di Android Studio, come
  fa `build-palmare.ps1`, piu' `ANDROID_HOME`;
- **la suite Android non e' coperta da nessun gate del frontend**: un test rosso
  si scopre solo quando si ricostruisce l'APK, e a quel punto **blocca la
  build**. Conviene eseguirla dopo ogni modifica in Kotlin, non dopo giorni;
- i tre dispositivi collegati sono **identici di modello**: prima di installare
  si guarda quale server hanno configurato, altrimenti si aggiorna il palmare
  sbagliato.

---

## 8. Due errori miei, scritti perche' non si ripetano

**L'ipotesi TLS sul palmare era sbagliata.** Nel file del 3 settembre (§10.4)
avevo scritto che la webapp integrata non faceva piu' l'handshake TLS. Non era
cosi'. La causa vera era in `KioskPreferences.kt`: la lista degli indirizzi
"vecchi" da scartare conteneva **l'indirizzo attuale del Pi**, quindi a ogni
avvio l'URL configurato veniva riconosciuto come obsoleto, sostituito con un
default che puntava a una rete inesistente, e la preferenza salvata
**sovrascritta**. Bastava leggere le preferenze dell'app con `adb shell run-as`
per vederlo subito. L'ipotesi era coerente con i fatti che avevo; i fatti erano
pochi.

**La comanda #07445 non era da 1,30 €.** L'avevo creata per riprodurre un difetto
e riferita come "1,30 €": in realta' il payload delle righe non aveva la forma
attesa dal backend e la comanda e' nata **senza articoli**. Una comanda vuota e'
un fantasma: senza righe non compare il recupero servizio, e con un ordine in
corso non compare nemmeno "Libera", quindi **dall'app non si poteva chiudere** e
il tavolo sarebbe rimasto occupato. E' stata annullata con la rotta di
annullamento indicando il motivo; il Tavolo 2 e' tornato ad ACCOMODATO e pulito.

> Vale la pena ricordarlo come comportamento del sistema, non solo come errore
> mio: **una comanda creata con righe malformate blocca il tavolo** e non ha una
> via d'uscita nell'interfaccia.

---

## 9. Come si verifica sul campo

Il metodo che ha funzionato, e che conviene ripetere:

1. **si misura prima e dopo**, non si guarda solo il dopo. Per ogni correzione e'
   stata rimessa la build precedente sul Pi, rieseguita la stessa prova, e
   verificato che fallisse. Senza questo passaggio "funziona" non vuol dire "l'ho
   corretto";
2. **si legge sempre dopo un ricarico**, cosi' quello che si vede viene dal
   server e non dallo stato locale;
3. **una prova deve avere un criterio esatto**. Un confronto per contenuto su uno
   stato sporco passa per caso: e' successo, e ha quasi nascosto il terzo
   difetto.

Esiti registrati oggi:

| prova | build precedente | con la correzione |
|---|---|---|
| azzerare le intolleranze | non arriva al server | azzerato |
| segnare e chiudere il dettaglio dopo 150 ms | persa | salvata |
| seconda intolleranza, nota ferma | — | salvate entrambe |
| bozza aperta piu' aggiornamento del server | **persa** | **mantenuta** |
| cambio tavolo con bozza aperta | riparte dal server | riparte dal server |

Misure a video della testata, su ogni tessera occupata: larghezza della durata
**74px**, scarto dal bordo destro **0**, spazio fra coperti e durata **4px**,
nessun troncamento con `23h 35min`, filigrana **0,3**. Durate lette a video:
`52g` nella tessera contro `52g 16h` nel dettaglio dello stesso tavolo, poi
`23h 35min`, `3h 53min`, `1g`.

**Sul palmare** (`R58YA1578XB`), dopo la ricostruzione dell'APK e
l'installazione: sala Gazebo, tessere con `17g 1h` e `16g 19h`, pastiglie della
durata tutte della stessa larghezza e allineate al bordo destro, coperti alla
loro sinistra, filigrana `ACCOMODATO` nella tinta nuova. L'URL configurato e'
sopravvissuto all'aggiornamento.

---

## 10. Aperti

| aperto | stato |
|---|---|
| **proxy che risponde 502** sul Pi invece di ritentare dopo un reset pre-header | deterministico, misurato tre volte; in locale ritenta e risponde 200. Blocca anche la suite, che sul Pi va eseguita in due parti. **Da decidere** |
| **`NODE_BIN` del Pi punta a un Node x86-64** su macchina aarch64 | sette test rossi, ma soprattutto chiunque lanci `restart-v5bt-linux.sh` usa quel Node |
| il gate della baseline **non copre** la suite backend (307 file) | da estendere |
| 11 rossi preesistenti nel `web-frontend` del palmare | nessun gate li guarda. **Non** vanno "risolti" copiando file |
| `removePaymentsForOrderIds` | codice morto, spostato nel modello di `monitor.control`. Cancellarlo e' una decisione a se' |
| fette `messaging`, `app_meta`, `fiscal` non consegnate sul Pi | passo a se' |
| campagna POS, punti 2–8 | Tavolo 5 consegnato e non pagato (6,00 €), Tavolo 3 con 17,70 € in sospeso |
| P2b: 63 route su 198 | restano 8 domini |

### Politiche e vincoli da rispettare

- **RET-01**: nessuna ritenzione su pagamenti, movimenti di cassa e documenti
  fiscali. Le 8 politiche approvate restano disabilitate;
- il dominio fiscale emette, verifica e annulla documenti **reali**: ogni
  spostamento li' dentro e' verbatim, e la copertura con gateway finto esiste
  gia'.

---

## 11. Dove guardare

| serve | file |
|---|---|
| stato ufficiale della migrazione | `ROADMAP_V6/POSTGRESQL/.../MIGRATION_STATUS.md` |
| dettagli della decomposizione, le 37 dipendenze perse, il metodo AST | `DOCUMENTAZIONE/HANDOVER_IA_STATO_20260903.md` §6 |
| procedura kiosk del palmare | idem, §10.2 |
| impacchettamento della consegna | idem, §14 |
| decisioni da non riaprire | idem, §17 |
