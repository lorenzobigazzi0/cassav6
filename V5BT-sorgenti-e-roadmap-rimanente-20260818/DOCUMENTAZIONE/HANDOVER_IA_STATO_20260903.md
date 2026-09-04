# Handover IA — stato al 2026-09-03 (sera)

Documento di passaggio completo. Sostituisce
`HANDOVER_IA_STATO_20260902.md`, che resta come storico della giornata
precedente; i tre handover del 2026-09-01 (`…P2B3_USERS_LIST…`,
`…P2B_SELECT_WORKSTATION…`, `…P2B_AUTH_LOGIN…`) sono storico dei singoli slice.

È scritto per chi riprende il lavoro **senza avere visto nulla di questa
sessione**. Dove una scelta è stata presa e chiusa, è scritto anche il perché,
così non viene riaperta; dove qualcosa è ancora aperto, è scritto cosa manca per
chiuderlo, e **cosa è stato provato senza successo**.

---

## Indice

1. [Ambiente di lavoro](#1-ambiente-di-lavoro)
2. [Hardware in campo](#2-hardware-in-campo)
3. [Il programma: dove siamo nella roadmap](#3-il-programma-dove-siamo-nella-roadmap)
4. [P2b — che cos'è il gate e come si misura](#4-p2b--che-cosè-il-gate-e-come-si-misura)
5. [I quattro domini chiusi, uno per uno](#5-i-quattro-domini-chiusi-uno-per-uno)
6. [Le 37 dipendenze perse — la scoperta più importante](#6-le-37-dipendenze-perse--la-scoperta-più-importante)
7. [Deploy sul Raspberry: procedura e rollback](#7-deploy-sul-raspberry-procedura-e-rollback)
8. [Test: cosa gira, cosa è verde, cosa è rosso e perché](#8-test-cosa-gira-cosa-è-verde-cosa-è-rosso-e-perché)
9. [I due alberi frontend gemelli](#9-i-due-alberi-frontend-gemelli)
10. [App Android del palmare](#10-app-android-del-palmare)
11. [Le icone dei pagamenti](#11-le-icone-dei-pagamenti)
12. [Le modifiche UI del 2026-09-03](#12-le-modifiche-ui-del-2026-09-03)
13. [Campagna POS su hardware reale](#13-campagna-pos-su-hardware-reale)
14. [Il pacchetto ZIP di consegna](#14-il-pacchetto-zip-di-consegna)
15. [Lavoro in corso, non finito](#15-lavoro-in-corso-non-finito)
16. [Aperti, per priorità](#16-aperti-per-priorità)
17. [Decisioni prese: non riaprire](#17-decisioni-prese-non-riaprire)
18. [Trappole operative già pagate](#18-trappole-operative-già-pagate)
19. [Giornata del 2026-09-04](#19-giornata-del-2026-09-04)

---

## 1. Ambiente di lavoro

**Root di lavoro**

```
D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818
```

Tutti i percorsi in questo documento sono relativi a quella radice, salvo dove
scritto altrimenti. Il livello sopra (`D:\sistemacassav6`) contiene gli ZIP di
consegna, i checkpoint e le directory `.staging` / `.rollback` / `roadmap-checkpoints`.

**Il workspace non è gestito con Git.** Non c'è `git log`, non c'è `git diff`,
non c'è modo di annullare una modifica se non ripristinandola da uno ZIP o da
`.rollback`. Conseguenze pratiche:

- prima di modificare un file, **verificare che sia nello stato descritto qui**;
- **un'altra sessione ha lavorato in parallelo** su questo stesso programma (lo
  slice `auth.sessionStatus` è opera sua): non dare per scontato di essere
  l'unico autore;
- checkpoint e ZIP **solo a slice concluso e verificato**, mai a metà;
- per sapere cosa è cambiato di recente, la sostituzione di `git status` è una
  scansione per data di modifica. Lo script pronto è in scratchpad
  (`cambiati.py`): cammina la radice saltando `node_modules`, `dist`, `build`,
  `.gradle`, `.print-spool` e stampa i file toccati dopo una certa data.
  `find -newermt` sull'albero intero **non finisce** (oltre 45.000 file, va in
  timeout): usare la versione Python con pruning.

**Sistema**: Windows 10 Pro, shell primaria PowerShell 5.1, disponibile anche Git
Bash. Node e npm installati; Python 3.12 con Pillow; `@babel/parser` presente in
`SORGENTE_SISTEMA/cassa-frontend/node_modules`.

**Scratchpad di sessione** (fuori dal repository, per file temporanei):

```
C:\Users\utente\AppData\Local\Temp\claude\d--sistemacassav6\<id-sessione>\scratchpad
```

Contiene gli strumenti costruiti in questa sessione e le prove per immagine.
Nomi utili: `variabili-libere.mjs`, `cambiati.py`, `icone.py`, `smoke-vivo.mjs`,
`swap.sh`, `rpi.py`, `diff-zip.py`.

**Note pratiche sulla shell**

- gli heredoc di Bash **mangiano i backslash**: `\\(` diventa `(`. È successo più
  volte e ha prodotto script rotti in modo silenzioso. Per qualunque script che
  contenga backslash o regex, **scrivere il file con lo strumento di scrittura
  file**, non con un heredoc;
- `tar` interpreta `C:/...` come host remoto. Usare la forma POSIX `/c/...`;
- PowerShell 5.1 non ha `&&`, né l'operatore ternario, né `??`.

---

## 2. Hardware in campo

### 2.1 Raspberry Pi (server DEV)

| voce | valore |
|---|---|
| host | `raspberrypi` |
| IP | `192.168.0.67` (già stato `192.168.1.79`: l'indirizzo **cambia**, verificarlo sempre) |
| architettura | aarch64, 4 GiB RAM |
| disco | 58 GB, 30% usato, 40 GB liberi |
| accesso | utente `admin`, **password fornita dal proprietario** |
| SSH a chiave | **non configurato** — `BatchMode` viene rifiutato per ogni utente |

La password non va scritta nel repository. In questa sessione è stata tenuta in
un file di scratchpad fuori dall'albero. Sul Windows di sviluppo **non c'è
`sshpass`**; ci sono `plink` e `paramiko` (lo script `rpi.py` in scratchpad usa
paramiko ed è il modo più comodo per eseguire comandi remoti).

**Vale la pena autorizzare una chiave pubblica sul Pi e smettere di passare
password.** È rimasto da fare.

**Porte**

| porta | servizio | verifica |
|---|---|---|
| 5380 | frontend **HTTPS** (certificato self-signed) | `/api/health` → 200 |
| 5381 | backend **HTTP** | `/api/health` → 200, `database.mode: "mysql"` |
| 22 | SSH | |
| 5432 | PostgreSQL | **filtrata**: resta locale, ed è corretto così |

Attenzione: `http://192.168.0.67:5381/mobile/` risponde **404** — il frontend
mobile è servito solo dalla 5380. La 5381 espone le API, non le pagine.

**Servizio**: `cassav5bt.service`, `active`, `NRestarts=0`.

**Configurazione attiva della printer farm**: il file che conta è
`/etc/systemd/system/cassav5bt.service.d/printer-farm.conf`. Quello nel
repository sotto `deploy/` è un **template**, non la configurazione in esercizio:
modificarlo non ha effetto sul Pi.

**Database**: MariaDB (`cassa_v5bt`) è la persistenza in esercizio. PostgreSQL 17
è installato e ha le migration **001 → 007** applicate, ma **nessun percorso dati
è commutato**: `database.mode` è `"mysql"`, `postgresql.enabled` è `false`. Le
migration preparano lo schema, non lo usano.

**Directory dell'applicazione sul Pi**

```
/home/admin/cassav5bt-current/cassa V5BT/SORGENTE_SISTEMA/cassa-frontend
```

(sì, con lo spazio in `cassa V5BT`: va sempre quotata).

**Attenzione a `/tmp`**: è una tmpfs da 2 GB. Le suite di test creano una
directory per test e in una giornata l'hanno **saturata** (3.663 directory), con
144 test in rosso per `database or disk is full`. Le suite sul Pi vanno lanciate
con `TMPDIR=/home/admin/tmp-test`.

### 2.2 Palmare (Android)

| voce | valore |
|---|---|
| seriale adb | `R58YA1578XB` |
| IP | `192.168.0.75` (ha già saltato fra `192.168.10.86`, `192.168.0.75`: **verificare sempre**) |
| package | `com.sentrapa.palmare.advanced` |
| activity | `com.sentrapa.webkiosk.MainActivity` |
| versione | `1.0.39` (`versionCode` 40) |
| minSdk / targetSdk | 24 / 34 |
| collegamento | USB, `adb` in `C:\Users\utente\AppData\Local\Android\Sdk\platform-tools` |

Vedi §10 per tutto ciò che riguarda l'app.

---

## 3. Il programma: dove siamo nella roadmap

Programma: **migrazione a PostgreSQL del sistema CASSAv6**, roadmap REV2.

Lo stato ufficiale è in
`ROADMAP_V6/POSTGRESQL/V6_POSTGRESQL_MIGRATION_ROADMAP_REV2/MIGRATION_STATUS.md`
— **non** in `DOCUMENTAZIONE/`. Se i due divergono, vince `MIGRATION_STATUS.md`.

| Fase | Stato |
|---|---|
| P0 baseline e inventario | IN_PROGRESS — MIG-002 e MIG-000 aperte |
| P1 infrastruttura PostgreSQL | IN_PROGRESS, gate `DEV_ONLY`; HW-01-PROD aperta |
| P2 foundation persistence | IN_PROGRESS, gate `DEV_ONLY` |
| **P2b decomposizione `server.js`** | **IN_PROGRESS — è qui che si lavora** |
| P3 … P15 | TODO, bloccate dal gate P2b |

**Nessun cutover è autorizzato. Nessun percorso dati è commutato.**

**Stima del residuo** (calcolata sul CSV delle 72 task): **11 fatte, 6 in corso,
55 da fare**, per **278–484 giorni-persona**. È una stima di programma, non un
impegno.

---

## 4. P2b — che cos'è il gate e come si misura

### La regola

Un dominio è chiuso quando **nessun corpo di handler HTTP chiama direttamente
`readDb()` o `writeDb()`**. L'app-state deve essere letto e scritto da un
*read model* o *write model* dedicato, iniettato dal composition root.

Il conteggio è **a profondità zero**, e lo è di proposito: il criterio non è che
il dominio smetta di leggere l'app-state — deve pur leggerlo — ma che a farlo sia
**un modello e non il handler**. Un handler che chiama un modello che legge è
conforme; un handler che legge da sé non lo è, anche di una riga sola.

### Lo strumento

```powershell
cd SORGENTE_SISTEMA\cassa-frontend
node scripts\postgresql-migration\p2b-domain-progress.mjs
```

Stato al 2026-09-03:

```
dominio          route  readDb  writeDb  file
catalog             5       0        0     0
commerce            7       0        0     0
configuration      19       0        0     0
identity            7       0        0     0
audit               2       2        1     1
messaging           6       3        0     2
fiscal              5       5        0     3
app_meta           12       4        2     2
crm                 8       7        4     1
operations         18       8        4     5
reservations       19      19       11     3
payments           51      33        4     6
sales              34      27       16    17
```

**38 route su 198 sono chiuse.** Nove domini restano aperti.

L'ordine suggerito per i prossimi, per dimensione crescente: `audit` (2/1),
`messaging` (3/0), `app_meta` (4/2), `fiscal` (5/0), poi `crm` (7/4) e
`operations` (8/4). I tre grandi vanno per ultimi: `reservations` (19/11),
`sales` (27/16, su 17 file) e `payments` (33/4).

### L'inventario dei confini (MIG-030, chiusa)

`npm run migration:pg:p2b-routes` rigenera
`reports/postgresql-migration/p2b/server-route-boundaries.csv`: **198 route su
198**, 193 `handlerKey` (cinque servono più path).

Numeri chiave: 13 domini su 14, **89 route cross-domain reali**, **124 che
attraversano un contenitore legacy**, 134 mutative, 144 che scrivono app-state,
1 sola non risolvibile staticamente (`health`, che non tocca nulla).

**Quel 124 è la misura reale del lavoro di fondo**: `posSettings` (130 route) e
`integration` (63) sono contenitori condivisi dentro cui convivono impostazioni,
sale, tavoli, ordini e prenotazioni. Scioglierli è il vero contenuto di
MIG-032/033. Un test impedisce alla colonna cross-domain di tornare satura, cosa
che accadeva quando quei due contenitori venivano attribuiti a un dominio: 175
route su 198 risultavano cross-domain, cioè l'informazione era nulla.

**Regola del gate**: la dichiarazione è autoritativa, l'analisi statica fa da
rete. Il gate fallisce se **deduce** un accesso che la dichiarazione non prevede;
dichiarare di più è ammesso e va motivato nella colonna `note`, perché l'analisi
non attraversa le iniezioni a metodo.

### Una precisazione importante sulla catena di dipendenze

Il CSV dichiara MIG-032 dipendente da MIG-031 (`server.js` sotto 25.000 righe).
**Non è un vincolo tecnico**: il pilot identity ha portato sette route a 0/0 con
`server.js` ancora a 38.800 righe. È una euristica su "quanto è scomposto il
monolite". Chi legge la catena non deve fermarsi ad aspettare MIG-031.

`server.js` oggi è a **31.471 righe** (era 38.831). Vedi §17 per perché la soglia
di 25.000 è stata valutata e **scartata**, non dimenticata.

---

## 5. I quattro domini chiusi, uno per uno

### 5.1 `identity` — 7 route

Un owner dell'app-state per route:

| route | owner |
|---|---|
| `users.list` | `backend/users/users-list-read-model.js` |
| `auth.changePin` | `backend/auth/change-pin-write-model.js` |
| `auth.selectWorkstation` | `backend/auth/select-workstation-write-model.js` |
| `auth.sessionStatus` | `backend/auth/session-status-write-model.js` |
| `auth.login` | `backend/auth/login-write-model.js` |
| `auth.logout` | `backend/auth/logout-write-model.js` |
| `users.save` | `backend/users/users-save-write-model.js` |

`backend/auth/volatile-session-cache.js` raccoglie i side effect Redis condivisi
fra login, logout e session status. **`users.save` non la usa di proposito**: le
sue `deleteSession` sono attese, il fallimento lancia un 503 invece di
restituire un booleano, e l'ordine è asserito dai test.

`auth.handlers.js`: 819 → 188 righe, 12 dipendenze. `users.handlers.js`: 306 → 25,
4 dipendenze.

**Trappola da conoscere**: `validateSessionContext` **non è una lettura pura**.
Su sessione scaduta filtra `db.sessions`, chiama `appendAuditEvent`, muove
`db.meta.lastWriteAt` e **poi** lancia il 401. Deve restare dentro il modello: se
la si sposta nel handler "perché tanto legge", si sposta fuori una scrittura.

### 5.2 `configuration` — 19 route

Da 19 `readDb` e 10 `writeDb` a 0/0. Cinque modelli, 824 righe:

| modello | route |
|---|---|
| `modules/settings/settings-read-model.js` | 4 letture |
| `modules/settings/settings-write-model.js` | 7 scritture + `saveOrderWorkflow` |
| `modules/radio/radio-read-model.js` | 2 letture |
| `modules/radio/radio-write-model.js` | 2 scritture |
| `modules/status/configuration-read-model.js` | 3 letture di stato |

`settings.handlers.js`: 657 → 313. `radio.handlers.js`: 209 → 128.

Tre cose che valgono anche per i domini successivi:

- **le route di stato non sono come le altre**: leggono con
  `allowMigrations: false`, **non validano la sessione**, e prendono le
  impostazioni da `menuSettingsRepository` con fallback sull'app-state. Tutte e
  tre le differenze sono conservate nel reader dedicato;
- **`settings.saveOrderWorkflow` è uscita anche da `server.js`** portandosi
  dietro verbatim l'effetto cross-domain sugli ordini: auto-consegna dei pronti,
  audit `order.auto_delivered_by_workflow_setting`, sync finanziario dei tavoli.
  La suite che lo copre è `order-delivery-confirmation.e2e`;
- le cinque scritture di `settings` hanno la stessa sequenza ma **non sono state
  accorpate** in un helper parametrico: differiscono per messaggio del 403, fetta
  di payload e origine della notifica. Un accorpamento sbagliato si vedrebbe
  tardi.

### 5.3 `catalog` — 5 route, e `commerce` — 7 route

`catalog` da 5/1, `commerce` da 8/6. Quattro modelli, 1.034 righe:

| modello | route |
|---|---|
| `modules/menu/menu-read-model.js` | catalogo, suggerimenti, menu integrazione, più venduti |
| `modules/menu/menu-write-model.js` | `settings.menu`, entrambi i rami |
| `modules/commercial-benefits/commercial-benefits-read-model.js` | elenco campagne |
| `modules/commercial-benefits/commercial-benefits-write-model.js` | le sei route che mutano |

`menu.handlers.js`: 701 → 372. `integration-menu.handlers.js`: 153 → 44.
`commercial-benefits.handlers.js`: 970 → 602 (restano gli aiutanti puri, ora
esportati per i modelli). `integration.menuTopSold` è uscita anche da `server.js`.

**Quattro cose che non vanno perse:**

1. **`settings.menu` è una route a due rami, non due route.** Senza `items` nel
   payload si comporta da lettura e ritorna presto; solo altrimenti verifica
   `manage_menu` e scrive. Nel write model resta **una sola funzione** con il suo
   ritorno anticipato. Spezzarla avrebbe inventato una route che non esiste.

2. **`readIntegrationMenuView` dichiara anche come inviare la risposta.** La
   cache veloce conserva il JSON **già serializzato**, quindi il reader ritorna
   `{json}` per il corpo già stringa e `{payload}` per l'oggetto; il handler
   resta il solo a scegliere fra `sendJsonString` e `sendJson`. È l'unica
   differenza rispetto al codice di partenza, ed è deliberata.

3. **La doppia lettura di `printCoupon` è voluta.** Legge, accoda il job di
   stampa — un effetto esterno — e **solo dopo** rilegge in `latestDb`, per non
   sovrascrivere ciò che l'accodamento ha nel frattempo scritto. Collassare le
   due letture farebbe sparire il job **senza che nulla fallisca**. Per questo
   `backend/tests/catalog-commerce.e2e.test.mjs` (`npm run test:catalog-commerce`)
   verifica che il job sopravviva alla scrittura successiva.

4. Il contesto di autenticazione già risolto dal middleware (`req.__authContext`)
   arriva ai modelli di `commerce` come **secondo argomento**, con lo stesso
   fallback su `validateSessionContext` di prima. Lo stato **201** di
   `createCampaign` resta nel handler: appartiene alla route, non alla regola.

---

## 6. Le 37 dipendenze perse — la scoperta più importante

### Il problema

Estraendo blocchi di handler da `server.js` verso moduli, **37 identificatori
sono rimasti indietro**: il modulo li usa, ma nessuno glieli inietta. Il modulo:

- passa `node --check` (è sintassi valida);
- il server **si avvia** (l'errore è a runtime, non in fase di import);
- e la route **restituisce 500 nel momento in cui quella riga viene eseguita**.

Se la riga sta in un ramo raro — un errore, un caso di bordo, una stampa — il
difetto può restare invisibile per settimane. È la classe di bug più pericolosa
di tutta l'operazione P2b, e va cercata **dopo ogni estrazione**.

### Perché le regex non bastano

Ci ho provato **tre volte con espressioni regolari e mi hanno ingannato tre
volte**: costanti dichiarate in gruppo, parametri con valore di default, arrow
function senza parentesi, destrutturazioni annidate. Ogni volta il conteggio
sembrava tornare e non tornava.

### Il metodo che funziona

Analisi delle **variabili libere su AST vero**, con `@babel/parser` (già presente
in `node_modules`). Lo script è
`scratchpad/variabili-libere.mjs`, ed è documentato in testa. In sintesi:

1. costruisce la catena di scope reale (modulo → funzione → blocco → catch),
   con un **primo passaggio di raccolta** delle dichiarazioni prima di
   risolvere, così le funzioni *hoisted* e le mutue ricorsioni non risultano
   libere;
2. risolve ogni `Identifier` contro quella catena, saltando le chiavi non
   referenzianti (`MemberExpression.property` non calcolata, `ObjectProperty.key`
   non calcolata, `VariableDeclarator.id`);
3. sottrae un elenco esplicito di globali;
4. **interseca il residuo con i nomi dichiarati al livello superiore di
   `server.js`**.

Il punto 4 è ciò che rende il risultato utilizzabile: il walker produce qualche
falso positivo, ma i nomi che il modulo **non risolve** *e* che **esistono nello
scope di `server.js`** sono esattamente le dipendenze rimaste indietro. Tutto il
resto è rumore e sparisce.

### Come rieseguirlo

```bash
node "<scratchpad>/variabili-libere.mjs"
```

Va aggiornata la costante `APP` in testa se cambia la radice. Output atteso oggi:

```
dipendenze non ricevute: 0
```

**Verificato oggi: 0.** Se dopo un'estrazione stampa un numero diverso da zero,
quel numero è il conto delle route che andranno in 500.

### Dove erano le 37

| file | quante |
|---|---:|
| `modules/payments/pay-ticket.handlers.js` | 10 |
| `modules/table-room-move/room-move.handlers.js` | 6 |
| `modules/payments/assign-bill.handlers.js` | 4 |
| `modules/pos-rooms/room-change.handlers.js` | 4 |
| `modules/integration/order-sync.handlers.js` | } |
| `modules/integration/bar-charge.handlers.js` | } |
| `modules/integration/order-comp.handlers.js` | } 12 in totale |
| `modules/integration/order-correction.handlers.js` | } |
| `modules/integration/order-transfer-request.handlers.js` | } |
| `modules/integration/print.handlers.js` | } |
| `modules/integration/table-move.handlers.js` | } |
| `modules/notifications/waiter-pause.handlers.js` | 1 (`buildAuditActor`) |

Il cablaggio è stato fatto passando i nomi mancanti dal composition root
(`backend/server.js`) alla factory del modulo, senza toccare la logica.

**Questa verifica va inserita nel rituale di ogni slice P2b**, insieme a
`npm run check:backend` e al gate dell'architettura.

---

## 7. Deploy sul Raspberry: procedura e rollback

Il deploy del 2026-09-03 è stato fatto e regge. `server.js` in esercizio è passato
da 38.799 a **31.471 righe**; servizio `active`, `NRestarts=0`; `/api/health` 200
su MariaDB; `/api/integration/menu` con **contenuto identico** al pre-deploy;
smoke sui quattro domini verde.

### La procedura

Lo script è `scratchpad/swap.sh`, da copiare sul Pi. Prende un timestamp e:

1. estrae l'archivio in staging (`/home/admin/p2b-swap-<ts>`);
2. **controlla la sintassi di ogni `.js` con il Node del Pi** — non con quello di
   Windows: le versioni differiscono, e un `node --check` verde in locale non
   garantisce nulla sul target. Se un file è rotto, si ferma prima di toccare
   l'esercizio;
3. ferma il servizio;
4. **rinomina** `backend` in `backend.baseline-<ts>` e mette al suo posto quello
   nuovo. Non cancella niente: il ritorno indietro è uno spostamento, non un
   ripristino da tar;
5. **riporta dentro `.print-spool/`**, che contiene i job di stampa reali e non è
   nell'archivio;
6. riavvia e attende `/api/health` con dieci tentativi.

### Rollback

Un comando. La directory precedente è accanto a quella in esercizio:

```
/home/admin/cassav5bt-current/cassa V5BT/SORGENTE_SISTEMA/cassa-frontend/backend.baseline-20260903-150540
```

Fermare il servizio, invertire i due `mv`, riavviare.

### Lo smoke post-deploy

`scratchpad/smoke-vivo.mjs`, da lanciare **da Windows contro il Pi**:

```bash
node smoke-vivo.mjs http://192.168.0.67:5381 <utente> <pin>
```

Confronta le route pubbliche del catalogo con la risposta catturata **prima** del
deploy (in `scratchpad/prima/`). Due dettagli imparati sul campo:

- il confronto **non può essere byte a byte** su tutto il corpo: `lastWriteAt` e
  `version` si muovono a ogni scrittura dell'app-state, e lo smoke stesso ne fa
  una salvando il menu. Il confronto sta sul **contenuto**, campo per campo,
  saltando quei due;
- il percorso corretto è `/api/auth/session/status`, **non**
  `/api/auth/session-status`. Ho sbagliato e ho letto un 404 come regressione.

---

## 8. Test: cosa gira, cosa è verde, cosa è rosso e perché

### In locale (Windows), da `SORGENTE_SISTEMA/cassa-frontend`

```powershell
npm run test:migration:pg:p2b-routes      # 8/8
npm run test:migration:pg:p2b-identity    # 3/3
npm run test:migration:pg:p2b-baseline    # 4/4
npm run gate:migration:pg:p2b-baseline    # comparison.ok: true
npm run gate:architecture-security        # 198 route, 0 violazioni
npm run test:catalog-commerce             # 2/2, include la stampa buono end-to-end
node --test --test-concurrency=1 backend/tests/continuity.e2e.test.mjs    # 69/69
node --test --test-concurrency=1 backend/tests/auth-session.e2e.test.mjs  # 25/25
```

Il gate completo di rilascio è `npm run test:release` (lungo: check backend,
smoke di pacchetto, preflight sorgente, audit architettura, gate, suite backend
di rilascio, test statici frontend, typecheck e build del mobile).

### `route-policy-architecture.test.mjs` — 73 rossi risolti

Dopo l'estrazione dei moduli questa suite statica è andata a **73 rossi**, tutti
per la stessa ragione: **ispezionava solo `server.js`**, e il codice che
controllava si era spostato nei moduli.

Due modifiche di principio:

- una costante `backendSource` che **concatena** `server.js` con
  `modules|auth|users|routes|core`, usata da tutte le asserzioni che devono
  vedere "il backend";
- una funzione `corpoFunzione(nome)` che estrae il corpo di una funzione per
  nome, al posto degli `indexOf` su offset ormai stantii.

Tre scelte di giudizio, esplicitate perché **non sono neutre**:

1. il test di budget righe della Fase M5 è stato riportato a leggere **solo
   `server.js`**: misura il monolite, non la somma;
2. l'asserzione che `metricScope "sync"` compaia prima di `"cancel"` è stata
   rilassata a **due asserzioni di esistenza**: l'ordine testuale non
   sopravvive alla separazione in file, e non era quello il contratto;
3. il `doesNotMatch` su `writeIntegrationOrderDb(db)` è stato **riportato al solo
   `server.js`**. Vedi §16: c'è una violazione preesistente in
   `modules/integration/relational-order-create.js:239`, identica nel backup del
   14 luglio; il guardiano non l'aveva mai vista perché guardava solo `server.js`.

### Sul Raspberry

La suite eseguita sull'albero in esercizio ha lasciato **23 rossi**. Sette hanno
causa nota; **sedici no**, e la loro classificazione è rimasta aperta. Il criterio
è: **zero rossi che non siano ambientali, e "ambientale" va dimostrato, non
supposto** — le 37 dipendenze perse si nascondevano esattamente così.

Cause già accertate:

| causa | rimedio |
|---|---|
| `aedes` e `typescript` assenti dal `node_modules` di agosto | `npm install --no-save aedes typescript` (sono devDependencies: il servizio non le carica, le 9 dipendenze di runtime restano intatte; `--no-save` per non toccare `package.json`) |
| `deploy/` e `scripts/` stantii sul Pi | spediti |
| `/tmp` saturo | `TMPDIR=/home/admin/tmp-test` |

Da classificare ancora: `station-state lastWriteAt coalescing`, `P3.39 flush
async owner`, i sette `Fase P preset restart …`, i tre `settings blocca aggiunta
tavoli …` (nuovi, mai visti prima — possibile interferenza con lo stato reale
lasciato dalla campagna POS), `[BE][P1] GET coalescente ritenta una sola volta`.

### Un rosso che è un artefatto di piattaforma

`listino-time-pricing` dà **15/16 su Windows** (`ECONNRESET` nella stampante TCP
finta del test) e **16/16 sul Pi**. È un artefatto della piattaforma, non una
regressione.

---

## 9. I due alberi frontend gemelli

Esistono **due copie del frontend mobile**:

```
SORGENTE_SISTEMA/mobile-frontend          <- quello servito dal backend su /mobile/
APPLICATIVI/Palmare/web-frontend          <- quello che finisce dentro l'APK
```

**Sono deliberatamente diversi**: 11 file divergono. Non sono un doppione da
riconciliare: la variante del palmare ha adattamenti suoi.

**La regola operativa**, imparata sbagliando: prima di modificare un file in uno
dei due alberi, **verificare con `diff -q` se è identico all'altro**. Se lo è, la
modifica va portata in entrambi. Se non lo è, va capito perché prima di toccarlo.

I tre file dell'ultima modifica (`paymentArticleUnits.ts`,
`TablePaymentWizard.tsx`, `tables.css`) erano identici fra i due alberi, quindi
sono stati allineati.

**Budget di righe**: `src/api/tables.ts` ha un tetto asserito da un test statico.
Una mia modifica lo ha portato da 2694 a 2706 righe; ho spostato
`readBackendPaymentId` in `analyticsTransactions.ts` e tolto un `description`
morto, scendendo a **2696** — ancora **2 sopra il tetto**. Lo scrivo perché è un
rosso vero, non chiuso. (Cinque altri file eccedono già il proprio budget di
centinaia di righe: il test misura solo alcuni.)

**Build**: `npm run build` in ciascuna delle due directory. Sono veloci (~3 s
l'una).

---

## 10. App Android del palmare

Sorgente: `APPLICATIVI/Palmare/android-app`. Script di build:
`APPLICATIVI/Palmare/build-palmare.ps1`.

### 10.1 L'architettura "integrata"

Fino alla 1.0.38 il palmare era un kiosk che **caricava la webapp dalla rete**.
Da oggi è **integrata**: la UI viene dagli asset dell'APK, **le chiamate `/api`
vanno sulla rete**.

Il meccanismo è in `PalmareWebAppAssets.kt`:

```kotlin
bundledWebApp.shouldIntercept(request.url, savedUrl)
    ?: super.shouldInterceptRequest(view, request)
```

`MainActivity.shouldInterceptRequest` chiede al bundle se quella URL è servibile
dagli asset. Se sì, la serve da `assets/mobile/`; se no (e `/api/...` è così),
lascia partire la richiesta di rete.

Gli asset arrivano dal task Gradle **`syncBundledWebApp`**, che copia
`web-frontend/dist` in `app/src/main/assets/mobile`. Il task **fallisce apposta**
se `dist/index.html` non esiste, con il messaggio "Frontend Palmare non
compilato. Esegui 'npm run build' in ../web-frontend."

**Il ciclo completo per aggiornare la UI del palmare è quindi:**

```powershell
cd APPLICATIVI\Palmare\web-frontend ; npm run build
cd ..\android-app ; .\gradlew assembleDebug
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

Saltare il primo passo produce un APK con la UI vecchia e **nessun errore**.

### 10.2 Configurazione kiosk (l'unico modo per cambiare l'indirizzo del server)

Le costanti sono in `MainActivity.kt`:

```kotlin
private const val URL_SETUP_UNLOCK_WINDOW_MS = 10_000L
private const val URL_SETUP_LONG_PRESS_MS = 5_000L
internal const val DEFAULT_SERVER_URL = "https://192.168.1.79:5380/mobile/"
```

**Procedura, che va eseguita esattamente così:**

1. avviare l'app (o `adb shell am force-stop` + riavvio);
2. **entro 10 secondi dall'avvio**, iniziare una pressione lunga sul logo;
3. tenerla per **almeno 5 secondi**;
4. si apre il dialogo del PIN. **Il PIN è l'ora corrente in formato `HHmm`** —
   `SimpleDateFormat("HHmm")` — quindi alle 17:56 il PIN è `1756`. Cambia ogni
   minuto;
5. si apre "Configurazione Kiosk" con il campo "Indirizzo URL";
6. **svuotare il campo prima di scrivere**. Se non lo si svuota, il testo si
   concatena: mi è successo di ottenere `192.168.1.717199`, un indirizzo che non
   esiste, con l'app che poi falliva in modo incomprensibile;
7. "Avvia Kiosk".

Se la finestra dei 10 secondi scade, la pressione lunga **non fa nulla e non dà
segnale**: bisogna riavviare l'app e rifare.

**`DEFAULT_SERVER_URL` punta ancora a `192.168.1.79:5380`, che è un indirizzo
vecchio.** È segnalato e **non corretto**: va aggiornato o, meglio, va reso
configurabile senza ricompilare.

### 10.3 Installazione: la firma

`adb install -r` fallisce con **`INSTALL_FAILED_UPDATE_INCOMPATIBLE`** se la
firma differisce. Sul dispositivo c'era la 1.0.32 firmata `3cdd433b…`; i build
di questa postazione sono firmati `dfe2671d…`.

L'unica via è **disinstallare e reinstallare**, che **cancella i dati dell'app**,
`saved_url` compreso. In questa sessione il proprietario ha autorizzato
esplicitamente disinstallazione e reinstallazione; **prima di rifarlo va chiesto
di nuovo**, e va messo in conto di **riconfigurare l'URL** subito dopo (§10.2).

L'APK attualmente installato è
`Palmare-Advanced-1.0.39-integrata-20260903b-debug.apk`, copiato in
`APPLICATIVI/Palmare/`.

### 10.4 Il problema aperto: login non raggiungibile — **ipotesi, non dimostrata**

**Sintomo**: dopo la reinstallazione, l'app mostra "Backend login non
raggiungibile" con URL `https://192.168.0.67:5380/mobile/`.

**Cosa è stato escluso:**

- non è la rete: il palmare (192.168.0.75) pinga il Pi con **0% di perdita**;
- non è il servizio: da Windows, `Test-NetConnection` su **5380 e 5381 risponde
  True**, e `curl` su entrambe dà **200** su `/api/health`;
- **non fidarsi di `/dev/tcp` dentro `adb shell`**: la `sh` di Android non lo
  supporta e riporta *tutte* le porte come chiuse. Mi ha dato un falso negativo
  su cinque porte di fila.

**Ipotesi principale, coerente con tutti i fatti ma non ancora provata:**

Il certificato del Pi è **self-signed**. `MainActivity` fa `handler.proceed()` in
`onReceivedSslError`, quindi finché la **pagina** veniva caricata via HTTPS dal
Pi, la decisione di accettare il certificato veniva presa una volta per quel
host, e le XHR successive verso lo stesso host la ereditavano.

Con la webapp **integrata**, il documento principale **non fa più handshake TLS**
— viene intercettato e servito dagli asset. Nessuna decisione sul certificato
viene mai presa, e la prima XHR verso `https://192.168.0.67:5380/api/...` trova
un certificato non fidato e **fallisce in silenzio**: `onReceivedSslError` non
viene invocata per le sottorisorse.

Se l'ipotesi è giusta, **è una regressione introdotta dal bundling**, non un
problema di configurazione.

**Prova più rapida** (l'app dichiara già `usesCleartextTraffic="true"` nel
manifest, e non c'è `network_security_config`): configurare il kiosk su

```
http://192.168.0.67:5381/mobile/
```

La pagina viene comunque dagli asset (il 404 della 5381 su `/mobile/` non
importa, perché quella richiesta è intercettata) e le API vanno in chiaro sulla
5381, che risponde 200. **Se il login passa, l'ipotesi è confermata.**

**Rimedi possibili, in ordine di preferenza**, una volta confermata:

1. installare il certificato del Pi fra quelli fidati dell'app, via
   `network_security_config` con un `trust-anchors` che includa un certificato
   in `res/raw` — è già presente `LocalHttpsTrust.kt`, da rileggere: forse la
   struttura c'è già e va solo collegata al WebView;
2. una richiesta di riscaldamento verso l'origine all'avvio, per far registrare
   l'eccezione sul certificato prima della prima XHR — **fragile**, dipende da
   dettagli interni di Chromium;
3. HTTP in chiaro sulla LAN — accettabile in DEV, **da non portare in
   produzione**.

### 10.5 Altro, minore

`WebKioskBatteryService` prova ancora a contattare **`192.168.1.166:8765`** e
fallisce ogni 5 secondi (`Battery report failed`). È un indirizzo di una rete
precedente, innocuo ma rumoroso nei log. Da ripulire.

---

## 11. Le icone dei pagamenti

Il proprietario ha fornito un set di icone scaricate in `C:\Users\utente\Downloads`.
Sono PNG ad alta risoluzione, **da 600 KB a 1,1 MB l'una**: dentro un bundle web
sono peso morto.

**Cosa è stato fatto** (script riproducibile: `scratchpad/icone.py`):

- gli **originali sono conservati** nel pacchetto, in
  `RISORSE_GRAFICHE/icone-pagamento-originali/` — 17 file, così il taglio si può
  rifare a un'altra misura senza ripartire dai download;
- le versioni per i frontend sono **ridotte a 128 px sul lato lungo** con
  LANCZOS, canale alfa conservato, e installate in **entrambi** gli alberi
  (`SORGENTE_SISTEMA/mobile-frontend/src/assets/icons/payments/` e
  `APPLICATIVI/Palmare/web-frontend/src/assets/icons/payments/`).

**Risultato: da ~7,6 MB a 144 KB per albero, 14 file.**

Mappa dei nomi (scaricato → repository):

| scaricato | repository | uso |
|---|---|---|
| `contanti.png` | `contanti.png` | metodo contanti |
| `carta.png` | `carta.png` | metodo carta |
| `satispay.png` | `satispay.png` | metodo Satispay |
| `buonopasto.png` | `buono-pasto.png` | metodo buono pasto |
| `contosospeso.png` | `conto-sospeso.png` | metodo conto sospeso |
| `assegno.png` | `assegno.png` | metodo assegno |
| `bonifico.png` | `bonifico.png` | metodo bonifico |
| `scontrino.png` | `scontrino.png` | ricevuta scontrino |
| `Scontrinoparlante.png` | `scontrino-parlante.png` | ricevuta |
| `fattura.png` | `fattura.png` | ricevuta fattura |
| `notadicredito.png` | `nota-di-credito.png` | — |
| `nonpagato.png` | `non-pagato.png` | — |
| `checklist.png` | `checklist.png` | — |
| `clienti.png` | `clienti.png` | — |

`invoice.png`, `creditnote.png` e `notpaid.png` sono i **doppioni inglesi** di
tre di questi: restano fra gli originali, non entrano nei frontend.

**`buono-pasto.png` è arrivato per ultimo** (17:59) e ha sostituito l'SVG
disegnato a mano che fino a quel momento rappresentava il buono pasto in
`TablePaymentWizard.tsx`. Le quattro icone in fondo alla tabella (nota di
credito, non pagato, checklist, clienti) **non sono ancora collegate a nulla**:
sono disponibili per gli stati dei documenti e per l'anagrafica clienti.

---

## 12. Le modifiche UI del 2026-09-03

Richiesta del proprietario, sul flusso di pagamento **"Dividi articoli"**. Sette
punti, tutti implementati in **entrambi** gli alberi frontend, entrambi
compilano:

1. **numero comanda e orario** nella `table-payment-article-group-head`, al posto
   del titolo del primo articolo (era "1x Amando" e non significava niente):

   ```tsx
   <strong>{group.orderNumber ? `Comanda ${group.orderNumber}` : "Comanda"}</strong>
   ```

2. **ordinamento alfabetico** degli articoli, sia dentro la card di ogni comanda
   sia nella lista unica. In `paymentArticleUnits.ts`:

   ```ts
   const comparePaymentArticleUnitsByName = (left, right) =>
     left.name.localeCompare(right.name, "it-IT", { sensitivity: "base" }) ||
     left.lineIndex - right.lineIndex ||
     left.unitIndex - right.unitIndex;
   ```

   `sensitivity: "base"` perché accenti e maiuscole non devono spostare un
   articolo; i due criteri successivi rendono l'ordine **stabile** a parità di
   nome. La lista piatta ordina per nome e poi per `orderCreatedAt`.

3. **"Continua" disabilitato** finché non è selezionato almeno un articolo o una
   comanda (`.table-payment-article-continue:disabled` in `tables.css`).

4. **checkbox nello stile dell'app** al posto del bottone
   "Seleziona/Deseleziona comanda", sia per le comande sia per gli articoli.

5. **la checkbox dell'articolo sta a destra del prezzo**, in posizione fissa. Il
   prezzo ha `min-width: 62px; text-align: right`, così la colonna delle
   checkbox non balla al variare della cifra. Le checkbox degli articoli sono
   `readOnly` e `pointer-events: none` (classe `is-static`): **non si cliccano —
   si clicca la riga**, come chiesto.

6. **le icone nuove** al posto degli SVG disegnati: 6 metodi di pagamento
   (`table-payment-method-glyph`) e 2 ricevute (`table-payment-receipt-glyph`).

7. **intestazione su due righe** (`table-payment-head-info`, ora
   `flex-direction: column`): prima riga il passo corrente (metodo di pagamento,
   nome del metodo, ricevuta), seconda riga tavolo e sala.

   ```tsx
   <h4 className="table-payment-head-info"
       aria-label={`${headerStepLabel} - ${tableDisplayLabel} - ${roomName?.trim() || "-"}`}>
     <strong>{headerStepLabel}</strong>
     <span>{tableDisplayLabel} - Sala: {roomName?.trim() || "-"}</span>
   </h4>
   ```

**File toccati** (in entrambi gli alberi):

- `src/pages/home/tables/payment/paymentArticleUnits.ts` — aggiunto `orderNumber`
  a `PaymentArticleUnit` e `PaymentArticleGroup`, più `getPaymentArticleOrderNumber`
  e il comparatore;
- `src/pages/home/tables/components/TablePaymentWizard.tsx`;
- `src/styles/tables.css`.

### Verifica: fatta il 2026-09-04 da Chrome, sul Raspberry

Il palmare è bloccato dal problema di §10.4, quindi la verifica è stata fatta
**dalla webapp servita dal Pi**, guidando Chrome con Playwright
(`scratchpad/chrome.mjs`, profilo persistente in `scratchpad/chrome-profilo`).
Il login da Chrome **funziona**: è un altro elemento a favore dell'ipotesi che il
guasto del palmare stia nell'origine intercettata, non nel backend.

Per poter verificare l'ordinamento serviva più di un articolo: il Tavolo 3 ne
aveva uno solo. È stata creata dall'app una **seconda comanda, la 7443**, con
quattro articoli inseriti apposta in ordine sbagliato — Red Bull, Fanta, Caffe
Corretto, Acqua Tonica — e portata a `delivered` con
`scratchpad/avanza-t3.mjs`, che passa da `integration.orders/sync` (una delle
route ricablate).

| punto | esito | prova |
|---|---|---|
| 1. numero comanda e orario nella testata | ok | `Comanda 7443 · 00:37` e `Comanda 7442 · 16:41`; il titolo "1x Amando" non c'è più |
| 2. ordine alfabetico | ok | nel gruppo: Acqua Tonica, Caffe Corretto, Fanta, Red Bull (inseriti al contrario). Nell'elenco unico, fra le due comande: Acqua Tonica, Amando, Caffe Corretto, Fanta, Red Bull |
| 3. "Continua" solo con una selezione | ok | `disabled=true` a zero selezioni; `false` con la comanda (4 articoli, 15,00 €) o con una riga (1 articolo, 4,00 €); di nuovo `true` dopo la deselezione |
| 4. checkbox al posto del bottone | ok | `label.table-payment-article-check` nella testata di gruppo |
| 5. checkbox a destra del prezzo, riga cliccabile | ok | `span.table-payment-article-check.is-static` dentro `row-side` dopo il prezzo; il click sulla **riga** seleziona |
| 6. icone nuove | ok | 7 metodi + 2 ricevute, tutte `<img>` con `naturalWidth > 0`; **zero SVG residui** nelle schede |
| 7. intestazione su due righe | ok | "Divisione conto", "Seleziona articoli", "Metodo di pagamento", "Carta", "Ricevuta" sopra; "Tavolo 3 - Sala: Attesa virtuale" sotto, a ogni passo |

Nessun incasso è stato registrato: si è arrivati al passo "Ricevuta" — dove il
pagamento è ancora una `pendingChunk` locale e la chiamata al backend avviene
solo in `confirmReceipt` — e si è chiuso. Il tavolo resta a **17,70 € da
riscuotere**.

**Due difetti trovati e corretti durante la verifica**, entrambi nei due alberi:

1. **"Continua" disabilitato non si vedeva.** La regola
   `.table-payment-article-continue:disabled` (specificità 0,2,0) veniva battuta
   da `:root[data-theme="light"] .table-payment-article-continue` (0,3,0), più
   avanti nel file: l'attributo `disabled` c'era e il cursore diventava
   `not-allowed`, ma il tasto restava dipinto come attivo. Aggiunta una regola
   `:disabled` dentro il blocco del tema chiaro.
2. **Le icone erano troppo piccole.** `.table-payment-method-icon` è da 18px
   perché ospitava disegni a tratto; le icone fornite sono illustrazioni
   dettagliate e a quella misura non si leggevano. Il contenitore passa a 32px
   **solo quando contiene una delle nuove immagini** (`:has(.table-payment-method-glyph)`),
   così gli SVG rimasti altrove non cambiano e la scheda, con `min-height: 72px`,
   non si riimpagina.

Entrambe le correzioni sono compilate e **già in esercizio sul Pi**.

---

## 13. Campagna POS su hardware reale

Sul dataset reale, lasciando i dati sul posto. Per ogni prova si registra cosa si
vede sul palmare **e** cosa risulta nell'app-state del Pi.

**Fatto e dimostrato:**

- **punto 1, ordini**: comanda `orders:07441` creata dal palmare, avanzata a
  `delivered` via `orders/sync`; e il 2026-09-04 la comanda **7443** creata da
  Chrome sul Tavolo 3 (Red Bull, Fanta, Caffe Corretto, Acqua Tonica, 15,00 €),
  anch'essa portata a `delivered`;
- **prima metà del punto 6, pagamento a conto unico in contanti**: 5,00 € dati,
  1,00 € di resto, pagamento `pay_a4b063cf…` da 4,00 € **finito in MariaDB**.

Sono esattamente le route in cui erano state ricablate le dipendenze perse: il
giro completo prova che il ricablaggio regge.

**Stato lasciato sul dataset**: il Tavolo 3 ha due comande consegnate e non
pagate, la 7442 (Amando, 2,70 €) e la 7443 (i quattro articoli, 15,00 €), per
**17,70 € da riscuotere**. È materiale di prova utile per il punto 6 — split per
articolo e alla romana — e va incassato o stornato quando la campagna riprende.

**Da fare, nell'ordine di dipendenza:**

2. cambi sala e cambi tavolo
3. unioni di conti
4. sconti
5. carte sconto (dominio `commerce`)
6. pagamenti — carta, ticket, split alla romana e **per articolo** (è il flusso
   di §12)
7. resi e storni
8. carichi e scarichi

---

## 14. Il pacchetto ZIP di consegna

Convenzione: `D:\sistemacassav6\CassaV6-software-e-aggiornamento-<ETICHETTA>-<data>.zip`,
circa **203 MB**, con accanto un `.sha256`. L'ultimo consegnato è
`…-P2B-MIG030-MIG031-20260902.zip`, 4.361 file, sha256
`2eda237123fc1e84fbcc3f3764cb88212d8357e9772ef9ea172083c353e8b717`.

**Struttura**: un'unica cartella radice che porta il nome dell'archivio, dentro
la quale c'è l'albero di lavoro, più due file generati:

- `ARCHIVE_INFO.json` — metadati, checksum dei documenti chiave, esito dei test,
  elenco delle esclusioni;
- `SOURCE_MANIFEST.tsv` — manifest dei file.

**Esclusioni** (validate confrontando l'elenco con il pacchetto precedente):

- `node_modules` in ogni albero
- `dist`, `build`, `WEBAPP_COMPILATA`
- `.gradle` e le uscite di build Android
- `*.apk`, `*.aab`
- `.print-spool/` (job di stampa reali)
- `.runtime/` e `.rollback/` alla radice
- cache, log privati, credenziali, certificati
- archivi di consegna annidati

**Il modo per verificare il filtro** è `scratchpad/diff-zip.py` (ZIP contro
albero su disco) e `scratchpad/verifica-pacchetto.py` (ZIP nuovo contro ZIP
precedente). Il secondo è quello che conta al momento della consegna: elenca i
file **spariti** rispetto al pacchetto precedente, ed è così che si scopre un
filtro troppo largo.

**Due esclusioni introdotte il 2026-09-03**, entrambe rispetto al pacchetto del
02, da conoscere perché sono una differenza rispetto a quanto consegnato prima:

- `SORGENTE_SISTEMA/mobile-frontend/certs/192.168.0.28*.pem` — sono una **chiave
  privata** e il suo certificato, per un IP di LAN che non è più in uso. Il
  pacchetto ha sempre **dichiarato** di escludere credenziali e certificati e
  invece li spediva. Ora sono esclusi davvero; si rigenerano con lo script
  `cert:lan` di `mobile-frontend`;
- `APPLICATIVI/Palmare/android-app/app/src/main/assets/mobile/**` — è la copia
  che Gradle sincronizza da `web-frontend/dist`, cioè output di build (99 file,
  3,8 MB). Per la stessa regola con cui si esclude `dist`, va escluso anche qui.
  **Il `.gitkeep` resta**: senza la directory, `syncBundledWebApp` fallisce.

Il pacchetto del 2026-09-03 è
`CassaV6-software-e-aggiornamento-P2B-CATALOG-COMMERCE-UI-20260903.zip`, 214 MB,
4.415 voci. **L'impronta è nel `.sha256` accanto all'archivio, non qui**: questo
documento sta dentro quell'archivio, quindi non può contenerne il proprio hash.
Rispetto al pacchetto precedente: 58 file nuovi, 4 spariti (i due `.pem` di cui
sopra e due `.pyc`).

---

## 15. Lavoro in corso, non finito

Al momento del passaggio ci sono **tre cose a metà**. In ordine di quanto manca:

1. **Verifica delle sette modifiche UI: fatta**, ma **da Chrome sul Raspberry**,
   non sul palmare (§12). Sul palmare resta da fare, e dipende dal blocco del
   login (§10.4): la prova più rapida è configurare il kiosk su
   `http://192.168.0.67:5381/mobile/`.

   **Il frontend mobile in esercizio sul Pi è stato aggiornato tre volte oggi**
   (`SORGENTE_SISTEMA/mobile-frontend/dist`). Le copie precedenti sono accanto,
   rinominate: `dist.baseline-20260904-001512`, `dist.precedente`,
   `dist.precedente2`. Il ritorno indietro è uno scambio di nomi.

   **Per usare i pagamenti serve scegliere un POS.** Senza, il dettaglio del
   tavolo mostra "Pagamenti disabilitati: inserisci un POS o conferma il fondo
   cassa" e il tasto "Riscuoti tavolo" **non esiste**. Il POS si sceglie da
   avatar → Pagamenti → menu a tendina: ci sono "POS Cassa Principale", "POS
   Terrazza" e "POS Mobile". È stato scelto **POS Mobile**; è una impostazione
   di sessione, non un movimento di denaro, e si torna a "Nessun POS" quando si
   vuole. I **contanti restano non disponibili** perché manca il fondo cassa:
   generarlo è un'operazione finanziaria e non è stata fatta.

2. **APK con l'icona del buono pasto.** `buono-pasto.png` è stato collegato in
   `TablePaymentWizard.tsx` **dopo** l'ultimo `assembleDebug`, e i due frontend
   sono stati ricompilati (build verdi), ma **l'APK non è stato rigenerato**.
   Serve `.\gradlew assembleDebug` e una nuova installazione.

3. **Aggiornamento dello ZIP di consegna** con tutto il contenuto di oggi,
   inclusa la cartella `RISORSE_GRAFICHE/icone-pagamento-originali/`. Era la
   richiesta in corso quando è stato chiesto questo handover.

E due voci di documentazione:

4. **`MIGRATION_STATUS.md`** non contiene ancora le 37 dipendenze perse né il
   metodo AST che le ha trovate. È la scoperta più importante della giornata e
   va scritta lì, non solo qui.

5. **Test statico stantio**: `tableDetailReservationManager` cerca ancora
   `showReservationManager`, che è stato rinominato in `withinReservationWindow`.
   Segnalato, non corretto.

---

## 16. Aperti, per priorità

**Bloccanti per il prossimo passo**

- il login del palmare (§10.4) — blocca la verifica UI e tutta la campagna POS;
- i **sedici rossi non classificati** sul Raspberry (§8). Vanno capiti prima di
  andare avanti: le 37 dipendenze perse si nascondevano esattamente in un rumore
  di fondo come questo;
- `src/api/tables.ts` è **2 righe sopra il budget** in entrambi gli alberi (§9).

**Di programma**

- **Attivazione delle policy di retention** — è l'unica cosa che tiene aperta
  MIG-026. RET-01 è decisa e la migration 007 è applicata, ma **nessuna policy è
  `enabled`**, ed è corretto così: sei delle otto riguardano tabelle non ancora
  create, e delle due esistenti `audit.events` è vuota. Serve prima uno scheduler
  che invochi le purge fuori dagli orari di servizio: oggi non esiste. Evidenza
  in `reports/postgresql-migration/mig026/raspberry-dev-sd-ret01-approval-20260902.json`.
  **Vincolo del proprietario da rispettare**: nessuna retention su pagamenti,
  movimenti di cassa e documenti fiscali; le otto policy approvate restano
  `enabled=false`.
- **MIG-002** e **MIG-000**: P0 non è chiusa.
- **MIG-013**: backup e PITR misurati solo su un database vuoto. Il drill con
  dataset reale e il backup su storage indipendente restano da fare.
- **SEQ-01** (Commerciale V2 contro migrazione) va chiusa prima di P4.
- **HW-01-PROD**: il gate P1/P2 è `DEV_ONLY`.
- **Attivazione Postazione**: `posSettings.workstations` è vuoto e l'utente
  `lorenzo` ha `workstationIds: []`. Sono due scritture di settings, in attesa di
  via libera.

**Debito noto**

- `modules/integration/relational-order-create.js:239` chiama
  `await writeIntegrationOrderDb(db)`, la scrittura con label generica che
  `route-policy-architecture` vieta. È **preesistente**, identica nel backup della
  baseline del 14 luglio; il guardiano non l'ha mai vista perché ispezionava solo
  `server.js`. Va deciso se correggerla o dichiararla.
- `DEFAULT_SERVER_URL` del palmare punta a un indirizzo di una rete vecchia.
- `WebKioskBatteryService` punta a `192.168.1.166:8765`, che non esiste più.
- Accesso SSH al Pi ancora a password.

---

## 17. Decisioni prese: non riaprire

**Il tasto indietro in "Divisione conto" non manca per errore.** In
`TablePaymentWizard.tsx`, `headerBackAction` è `null` **solo** per
`step === "mode"`, e il wizard parte sempre da lì
(`useState<WizardStep>("mode")`): è il primo passo, dietro non c'è nulla, e la X
torna al dettaglio del tavolo. Tutti gli altri passi hanno il `‹` perché hanno un
precedente.

**La soglia di 25.000 righe di MIG-031 è stata valutata e scartata**, non
dimenticata. In `server.js` restano **10 handler per 284 righe** in tutto:
estrarli costerebbe dieci cicli per ~130 righe nette. Il resto sono helper
*hoisted* referenziati a metà file; spostarli in una factory li rende `const` in
**temporal dead zone**. Sul blocco fiscale la finestra di collocazione è **vuota,
misurata**: primo uso a riga 12.387, ma `readDb` è definita a 16.466 e
`findPosFiscalReceiptByPaymentId` a 21.340. Siccome `readDb`/`writeDb` stanno a
~16.500 e servono a quasi ogni helper, **ogni blocco referenziato prima di quella
riga ha lo stesso problema**.

Se si vorrà riprendere, la tecnica praticabile è la **facciata hoisted con
risoluzione pigra**: un guscio `function` in `server.js` che dereferenzia il
modulo **al momento della chiamata** invece che all'inizializzazione. Immune alla
TDZ per costruzione, costa ~3 righe per funzione esportata (sul blocco fiscale:
90 righe di gusci al posto di 1.839, netto −1.750). L'unica verifica per blocco è
che nessuna di quelle funzioni venga invocata **durante l'inizializzazione del
modulo**, dove nemmeno il guscio pigro salverebbe.

**Le cinque scritture di `settings` non vanno accorpate** in un helper
parametrico (§5.2).

**`settings.menu` resta una funzione sola** con il suo ritorno anticipato (§5.3).

**La doppia lettura di `printCoupon` resta** (§5.3).

**I due alberi frontend restano due** (§9).

---

## 18. Trappole operative già pagate

Elenco di errori concreti commessi in questa sessione, con il rimedio. Servono a
non ripagarli.

| trappola | cosa è successo | rimedio |
|---|---|---|
| **heredoc di Bash** | `\\(` diventa `(`: script rotti in silenzio | scrivere gli script con lo strumento di scrittura file |
| **`tar` con percorsi Windows** | `C:/…` interpretato come host remoto | usare `/c/…` |
| **`pkill -f 'test-concurrency=1 backend/tests'`** | il pattern ha incluso **la propria shell SSH**, che si è uccisa | mai `pkill -f` con un pattern che compare nella riga di comando corrente |
| **`pkill -x node`** | troppo largo: **poteva abbattere il servizio in esercizio**. Per fortuna non ha trovato nulla (`comm = MainThread`, `NRestarts=0`) | uccidere **per PID**, sul percorso di staging |
| **`/tmp` del Pi** | 2 GB di tmpfs saturati da 3.663 directory di test: 144 rossi per `database or disk is full` | `TMPDIR=/home/admin/tmp-test` |
| **devDependencies assenti sul Pi** | `aedes` e `typescript` mancanti → 7 rossi | `npm install --no-save` (non tocca `package.json`) |
| **`/dev/tcp` in `adb shell`** | la `sh` di Android non lo supporta: **tutte le porte risultano chiuse** | provare le porte da Windows (`Test-NetConnection`, `curl`) |
| **confronto byte a byte del menu** | lo smoke scrive e muove `lastWriteAt`/`version`: falso rosso | confrontare campo per campo saltando quei due |
| **percorso API sbagliato** | `/api/auth/session-status` → 404. Il vero è `/api/auth/session/status` | leggere la route, non ricordarla |
| **campo URL del kiosk non svuotato** | il testo si concatena: `192.168.1.717199` | svuotare il campo prima di scrivere |
| **finestra dei 10 s del kiosk** | la pressione lunga fuori finestra **non dà alcun segnale** | riavviare l'app e ricominciare |
| **firma dell'APK** | `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | disinstallare e reinstallare, **previa autorizzazione**, e riconfigurare l'URL |
| **`find -newermt` sull'albero** | non finisce, va in timeout | `cambiati.py`, con pruning |
| **IP che cambiano** | il palmare ha saltato fra tre reti, il Pi fra due: falsi allarmi | verificare l'IP **prima** di dichiarare un guasto |
| **Git Bash riscrive i percorsi POSIX** | `python carica.py file /home/admin/x` è arrivato a paramiko come `C:/Program Files/Git/home/admin/x`, e l'errore letto era un ENOENT SFTP che sembrava un guasto del Pi | passare il percorso remoto **relativo** (`x`), che il server risolve dalla home; oppure `MSYS_NO_PATHCONV=1` |
| **`hasText` con regex è sensibile alle maiuscole** | `filter({hasText: /PAGARE/})` non trovava nulla: nel DOM il testo è "Pagare", l'uppercase è `text-transform` CSS. La forma stringa invece funziona, perché è case-insensitive | usare `/pagare/i`, o meglio l'`aria-label` (`"Apri dettagli Tavolo 3"`), che identifica il tavolo per numero e non per stato |
| **contesto Playwright non persistente** | a ogni avvio si ripartiva dal login e la scelta del POS spariva, quindi "Riscuoti tavolo" non c'era | `launchPersistentContext` con una cartella di profilo |
| **la notifica di chiamata blocca tutto** | `.call-overlay` è modale e intercetta ogni click, senza che il messaggio d'errore lo dica in modo evidente | chiuderla prima di navigare |

---


---

## 19. Giornata del 2026-09-04

### 19.1 Dominio `audit` chiuso: cinque domini, 40 route

`audit` passa da 2 `readDb` e 1 `writeDb` a **0 e 0**. Due modelli nuovi in
`backend/modules/audit/`; i due handler restano in `reports.handlers.js` — dove
sono sempre stati, accanto ai report di vendita che appartengono ad altri
domini — ridotti a leggere il corpo, chiamare il modello e rispondere.

Test nuovo `backend/tests/audit-domain.e2e.test.mjs`, con lo script
`npm run test:audit-domain`. Copre la cosa che nessun altro test guardava: la
**cancellazione e logica e idempotente**, e il ramo `if (!currentEvent.deletedAt)`
impedisce che una seconda cancellazione riscriva autore e data della prima.
Quel ramo e stato **tolto apposta** per verificare che il test lo veda: il test
e fallito con il messaggio atteso, ed e stato rimesso.

`server.js` da 31.471 a **31.502** righe: il cablaggio nel composition root
aggiunge cio che toglie ai moduli, ed e il compromesso previsto.

### 19.2 Due dipendenze rotte in `settings`, e perche non le avevo viste

Il collaudo sul Raspberry ha trovato **HTTP 500** su
`/api/settings/pos/areas/save`, con tre test di
`settings-room-table-policy.e2e` rossi. Il test e del 18 agosto e non e stato
toccato: si e rotta la route. Causa:
`findRoomTableExpansionViolations is not defined`.

**Il mio analizzatore aveva dichiarato zero, e sbagliava.** Intersecava le
variabili libere con i soli nomi dichiarati al livello superiore di
`server.js`, filtro introdotto per sopprimere i falsi positivi del walker. Quel
filtro nasconde tutto cio che vive in un **modulo fratello**: la funzione sta in
`settings.handlers.js`, ed e stata scartata come rumore. La versione corretta e
`scratchpad/variabili-libere2.mjs`, che interseca con l'unione dei nomi
esportati da **tutti** i moduli del backend (287 moduli, 2.610 nomi) piu il
composition root. Verifica fatta rimettendo il difetto: la versione vecchia
continua a dire 0, la nuova lo trova.

**Esiste una seconda classe di guasto che nessuna analisi di variabili libere
puo vedere.** Una dipendenza *dichiarata* fra i parametri destrutturati della
factory e mai passata dal composition root **non e** un `ReferenceError`: il
nome e definito e vale `undefined`. Si manifesta solo alla chiamata, come
`x is not a function`. Serve un secondo controllo, che confronti i parametri
dichiarati da ogni `createXxx({ ... })` con le chiavi effettivamente passate:
`scratchpad/dipendenze-non-passate.mjs`, 62 factory esaminate. Ha trovato
`writeUserPaymentPreferences`, dichiarata come parametro e mai passata, che per
giunta **ombreggiava** l'import omonimo gia presente nel modulo — dentro la
factory valeva `undefined`.

**Dopo ogni estrazione vanno eseguiti tutti e due.** Oggi tornano 0 e 0.

### 19.3 I dodici rossi del Raspberry, classificati

Suite completa sull'albero in esercizio, con `TMPDIR=/home/admin/tmp-test`:
**2.058 verdi, 12 rossi**. Il file `static-proxy.e2e.test.mjs` **blocca** la
suite dopo il proprio fallimento, quindi e stata eseguita in due parti,
fermando la prima per PID e riprendendo dai file successivi.

| rossi | causa | stato |
|---|---|---|
| 3 · `settings … aggiunta tavoli` | **difetto vero**: `findRoomTableExpansionViolations` non importata → 500 | corretto in locale, **da ridistribuire sul Pi** |
| 7 · `Fase P preset restart …` | **ambientale, dimostrata** (sotto) | nessuna azione sul codice |
| 1 · `frontend impostazioni invia locale…` | test stantio **preesistente** | da allineare o mettere in allowlist |
| 1 · `[BE][P1] GET coalescente ritenta…` | **il proxy non ritenta sul Pi e risponde 502** | da decidere, vedi sotto |

**I sette "Fase P" hanno una causa sola, ed e istruttiva.**
`tools/restart-v5bt-linux.sh` esegue l'audit del workflow ordini con `NODE_BIN`,
e se l'audit non parte forza `BACKEND_MULTI_PROCESS_ORDER_WORKFLOW_AUDIT_GO=0`.
Sul Pi `NODE_BIN` punta a
`.runtime/node-v22.23.1-linux-x64/bin/node`, che e un binario **x86-64 su una
macchina aarch64**: `cannot execute binary file: Exec format error`. Lo script
e identico fra locale e Pi (sha256 `3eaf1431…`), quindi non e un problema di
allineamento del codice. **Non e solo un artefatto di test**: chiunque lanci
davvero quel comando di riavvio sul Raspberry usa lo stesso Node sbagliato.

**Il rosso del proxy non e un artefatto di test, ed e il piu importante dei
dodici.** Misurato tre volte sul Pi con esito identico (235,6 / 235,5 / 235,0
ms): non e intermittente. Con il reporter TAP l'errore e

```
error: 'Content-Length pipeline non valido per HTTP/1.1 502 Bad Gateway'
```

cioe il proxy, davanti a un worker che chiude il socket **prima degli header**,
**non ritenta sul worker successivo e restituisce 502 al client**. Sulla
macchina di sviluppo ritenta e risponde 200 dal secondo worker, sempre.

La rete di sicurezza del ritentativo singolo pre-header quindi **esiste dove si
sviluppa e non dove il software gira**. Va deciso se e un difetto del proxy da
correggere o un limite accettato e da documentare; in entrambi i casi non va
archiviato come "ambientale".

Come effetto collaterale, dopo quel fallimento **il file blocca la suite**: la
promessa delle risposte in pipeline non si risolve mai e `node --test` resta
appeso a tempo indefinito. Finche non e sistemato, la suite sul Pi va eseguita
in due parti, o il file va escluso ed eseguito a parte con `timeout`.

Il rosso `frontend impostazioni invia locale` legge
`settings-frontend/dist/assets/settings-app.js`. Compilare quel frontend non lo
risolve: il build attuale produce `assets/main.js` e un albero modulare, non
piu quel nome. L'attesa e vecchia. **E preesistente**: il caso e identico, con
lo stesso percorso, nel pacchetto del 2026-09-02.

### 19.4 Il gate della baseline non copre la suite backend

Va detto chiaro perche cambia il modo di lavorare. I 20 rossi noti del gate
sono **tutti test statici di frontend** dentro `cassa-frontend` (suite da 92).
La suite `npm run test:backend` — **307 file** — non e sorvegliata da nessun
gate. E per questo che i tre 500 di `settings` non hanno fatto scattare niente:
il gate era verde mentre una route era rotta.

Chi riprende dovrebbe considerare di estendere la baseline alla suite backend.
Finche non lo e, l'unico modo di accorgersene e eseguirla.

### 19.5 Cinque regressioni nel mobile-frontend, trovate e chiuse

Il gate ha segnalato `mobile-frontend` a 634/8 contro i 639/3 attesi. Cinque
rossi nuovi, tutti miei, tutti dalle modifiche UI:

1. **Due su `paymentArticleUnits`**: avevo messo l'ordinamento alfabetico dentro
   `expandOrdersToUnits`, che pero serve anche a
   `expandOrdersToAdjustmentUnits` — la rettifica dei prezzi, che con la vista
   di cassa non c'entra nulla. Due test asserivano l'ordine di emissione.
   **L'ordinamento e stato spostato dove si disegna**: nei gruppi lo fa gia
   `groupPaymentArticleUnits`, per l'elenco unico c'e ora
   `sortPaymentArticleUnitsByName`, e l'espansione torna a restituire l'ordine
   di emissione, che e il suo contratto.
2. **`analyticsPaymentMovementModel`**: asseriva ancora `note: "saldo tavolo"`.
   La mappatura `description` → `note` e stata tolta **apposta**, perche il
   record del server non porta quell'etichetta e la nota compariva per poi
   sparire al primo aggiornamento — il difetto segnalato sulla card transazioni.
   Il test e stato allineato, non cancellato.
3. **`nativeBridgeFunctionality`** e **`paymentActionButtonsVisual`**:
   codificavano l'intestazione a una riga. Riscritti sul contratto nuovo, che
   verifica anche che le due righe siano due elementi distinti.

Dopo le correzioni: **639 passati, 3 falliti** — esattamente la baseline, e il
gate torna `ok: true`.

### 19.6 L'albero del palmare ha undici rossi che nessuno guarda

`APPLICATIVI/Palmare/web-frontend` ha **11 test rossi**, e non e in nessun gate.
Verificato che **nessuno e di oggi**: i file dei test falliti sono del 18
agosto e i sorgenti che leggono del 28, mentre gli unici file toccati oggi sono
i tre che ho corretto, che ora passano. Sono la conseguenza delle divergenze
volute fra i due alberi — per esempio
`paymentActionButtonsVisual > mantiene uno slide-to coerente` cerca
`table-detail-free-slide` dentro `TableDetailPanel.tsx`, ma in
`mobile-frontend` quella conferma e stata estratta in
`TableFreeConfirmDialog.tsx` e nel palmare no.

**Attenzione a non "risolverli" copiando i file fra i due alberi**: le
divergenze sono deliberate e copiare le cancellerebbe. Le tre correzioni di
oggi sono state applicate al palmare con sostituzioni puntuali, non copiando.

### 19.7 Deploy della correzione sul Raspberry

Fatto con la procedura di sempre (`scratchpad/swap.sh`): staging, controllo
sintassi con il Node del Pi su ogni `.js`, arresto, **scambio per rinomina**,
`.print-spool` riportata dentro (23 job reali), riavvio, salute.

- `server.js` in esercizio: **31.501 righe**
- servizio `active`, `NRestarts=0`, `/api/health` 200 su MariaDB
- i **tre rossi di `settings … aggiunta tavoli` sono verdi sul Pi**
- `audit-domain.e2e` 2/2 sul Pi
- percorso completo dalla webapp in Chrome ancora verde dopo il riavvio

Rollback a un comando: la directory precedente e accanto a quella in esercizio,
`backend.baseline-20260904-025821`.

### 19.8 Lo smoke diceva cinque rossi che rossi non erano

Dopo il deploy `smoke-vivo.mjs` ha segnalato cinque differenze rispetto al
pre-deploy. Guardate una per una, nessuna era una regressione:

- **cinque prodotti con prezzo diverso** (Corona 4,50 -> 5,00): il listino a
  fasce e passato da `diurno` a `notturno`. La fotografia di confronto era
  stata presa di giorno, il confronto girava alle 03:00. E la funzione che
  lavora, non un difetto;
- **`activeStations` da `[]` a `["BAR-1"]`**: c'e una sessione collegata;
- **piu venduti diversi**: e stata presa la comanda 7443 poche ore prima.

Il difetto era **nello smoke**, che confrontava byte a byte campi che si
muovono da soli, e avrebbe detto "rosso" a ogni esecuzione futura in cui
qualcuno avesse lavorato. Ora esclude i campi volatili (`lastWriteAt`,
`version`, `activeStations`, e i tre del listino a fasce) e al loro posto
verifica cio che quei campi devono comunque garantire: che **tutti i 125
prodotti abbiano un prezzo numerico** e che i piu venduti abbiano forma valida.
Identita, struttura e ogni altro campo restano confrontati con il pre-deploy,
quindi un reader che perdesse un prodotto o una categoria si vedrebbe ancora.

Allo smoke e stato aggiunto anche il dominio `audit`, **in sola lettura**:
elenco, ordine dal piu recente, coerenza di `count`, limite e filtro per
azione. La cancellazione di un evento e un'operazione reale sul dataset del
proprietario e non ha posto in uno smoke.

Esito: **tutto verde**, cinque domini coperti.

### 19.9 Dominio `messaging` chiuso: sei domini, 46 route

Da 3 `readDb` a **0/0** su tutte e 6 le route.
`notifications.handlers.js` scende da **768 a 84 righe**.

Tre cose da sapere:

- **le tre route delle notifiche stanno in un file solo**, non divise fra read
  model e write model. `notifications/pull` e dichiarata non mutativa ma
  **scrive**: tocca l'heartbeat delle sessioni e fa il flush delle chiamate
  differite. Separarle direbbe una cosa falsa;
- **due funzioni restituiscono una busta `{ stato, corpo }`** invece del solo
  corpo: `acknowledgeNotification` e `resolveNotificationStreamSession` hanno
  rami che rispondono **401** con un `code` (`NOTIFICATION_SESSION_REVOKED`,
  `NOTIFICATION_IDENTITY_REQUIRED`) su cui il client fa affidamento, e che un
  `HttpError` generico perderebbe. Lo stato li dipende dai dati ed e deciso in
  fondo al flusso: non poteva restare nel handler senza duplicare il controllo.
  Le altre, che rispondono sempre 200, restituiscono il corpo e basta;
- **della route SSE `notifications/stream` e uscita solo l'autenticazione.** Il
  parsing della query e la consegna al runtime SSE restano nel composition root:
  sono route e trasporto, non dominio.

**L'analizzatore allargato di §19.2 ha ripagato il suo costo alla prima
occasione**: ha segnalato `compareIntegrationNotifications` non importata nel
modello nuovo — la stessa classe di guasto che stamattina aveva prodotto tre
500 — prima che uscisse dalla macchina di sviluppo. La versione vecchia non
l'avrebbe vista.

### 19.10 Una trappola nuova: le fine riga non sono uniformi

`backend/server.js` usa **LF**, i moduli sotto `backend/modules/` usano
**CRLF**. Uno script che ricava la fine riga da un file e la applica all'altro
non trova nessuna corrispondenza, e fallisce in modo poco chiaro. Chi scrive
strumenti che toccano entrambi deve tenere due variabili distinte, come fa
`scratchpad/slice-stream.py`.

### 19.11 Una route era invisibile all'inventario per via di due virgolette

Aprendo `app_meta` e saltato fuori che **`health` legge l'app-state** — riga
1578 di `status.handlers.js`, `db.meta` come fallback quando lo snapshot di
salute non porta `settingsVersion` — mentre la sua dichiarazione diceva
`reads: []` con la nota "Endpoint di stato: nessun accesso app-state".

Il motivo e piccolo e sgradevole. `indexHandlerExpressions` riconosce le voci
del dispatch **solo se la chiave e fra virgolette**; nella mappa di
`status.handlers.js` la voce era scritta

```js
  return {
    health: handleHealth,          // <- senza virgolette, unica fra tutte
    "settings.orderWorkflow": handleOrderWorkflowSettings,
```

Quindi `health` non veniva indicizzata, `resolve("health")` rispondeva
"handlerKey assente dal dispatch", e — siccome il gate fallisce **solo quando
deduce** un accesso non dichiarato — per una route irrisolvibile non poteva
dedurre niente. La dichiarazione non e mai stata controllata da nessuno.

**Questo mette in prospettiva il "197 su 198 risolte"**: quel numero non era una
misura del codice ma dello stile con cui erano scritte le chiavi.

Corretti tutti e due:

1. **l'analizzatore** accetta ora anche le chiavi non quotate, purche siano
   identificatori e il valore sia una funzione `handleXxx` — la forma di ogni
   voce di dispatch. E la correzione che conta;
2. **la chiave** nel sorgente e stata quotata come le altre.

Effetto: `unresolvedRouteCount` da 1 a **0**, e `app_meta` da 4 a **5 `readDb`**
residui. La dichiarazione di `health` e ora `reads: ["meta"]` con la motivazione
in `note`, perche l'analizzatore non attribuisce la collezione a un `await`
inline e quindi qui si dichiara piu di quanto lui deduca — che la regola
permette, chiedendo di scriverne il perche.

**Vale la pena cercare se ci sono altri punti in cui il gate non puo fallire per
costruzione**, invece di passare perche tutto e a posto.

### 19.12 Proiezione monitor estratta, e una trappola che nessun analizzatore vede

`buildMonitorOverview` e le 590 righe di proiezione che la circondano stavano
dentro la chiusura di `createStatusHandlers`. Finche restavano li,
`monitor.overview` e `monitor.control` **non potevano** avere un modello di
dominio: il modello si crea nel composition root e non poteva raggiungerla, e
passargliela avrebbe creato una dipendenza circolare — il modello serve ai
handler, e la funzione ai handler sarebbe stata nel modello.

Ora sono in `modules/status/monitor-projection.js`, una factory
`createMonitorProjection` con **27 funzioni** e **6 dipendenze**, creata una
volta sola nel composition root. Nove funzioni tornano indietro a
`status.handlers.js`, che scende da **1.784 a 1.203 righe**.

**Questo passo non ha chiuso nessun dominio**: `app_meta` resta a 5 `readDb` e 2
`writeDb`, ed e voluto. E la precondizione del passo successivo.

#### La rete di test, scritta prima

`monitor.control` — route amministrativa che muta e include `reset_all_tables` —
era sfiorata da **due sole menzioni** in un altro file, e `appState.get`/`sync`
non avevano alcun e2e. `backend/tests/app-meta.e2e.test.mjs`
(`npm run test:app-meta`) fissa cinque casi; il piu importante confronta la
proiezione servita da `/api/monitor/overview` con quella **incorporata nella
risposta** di `/api/monitor/control`, perche e lo stesso codice in due posti ed e
il legame che un'estrazione sbagliata spezza.

Due asserzioni sono state deliberatamente indebolite dopo averle misurate:

- i **campi** dei tavoli non si confrontano fra le due chiamate, perche portano
  tempi trascorsi che si muovono da soli;
- nemmeno lo **stato**: e stato misurato che `room_pedana_t05` passa da
  `waiting` a `payment_due` fra la risposta di control e la lettura successiva,
  perche la conseguenza finanziaria si assesta dopo. Sarebbe stato un test sui
  tempi, non sulla proiezione. Resta l'elenco dei tavoli, che deve coincidere.

La rete e stata verificata togliendo apposta la sezione `stations` dalla
proiezione: due casi cadono con il messaggio atteso, e rimettendola tornano
verdi.

#### Cosa hanno preso i controlli, e cosa no

Tre difetti in un'estrazione sola, e **ognuno e stato preso da uno strumento
diverso**:

1. `variabili-libere2.mjs` ha trovato **due import a livello di modulo** che il
   blocco usava senza portarseli dietro — `buildHandheldSessionReport` e
   `normalizeTableCovers`. Avevo cercato le dipendenze fra i *parametri* della
   factory e quelle non lo erano;
2. `dipendenze-non-passate.mjs` non ha trovato nulla, correttamente;
3. **la rete di test ha preso quello che nessun analizzatore poteva vedere.**
   Nel composition root due delle sei dipendenze erano passate **rinominate** —
   `appEnv: APP_ENV` e `getRuntimeFeatureProfile: getP43RuntimeFeatureProfile` —
   e io avevo copiato la lista **per nome della chiave**, generando `appEnv,`
   in forma abbreviata. Il risultato e stato `ReferenceError: appEnv is not
   defined` **all'avvio del server**.

Il punto 3 merita di essere ricordato: `variabili-libere2` ispeziona i moduli e
non `server.js`, e `dipendenze-non-passate` controlla che la *chiave* sia
passata, non che il suo *valore* esista. **Copiare una lista di dipendenze per
nome di chiave perde i rinomini al punto di chiamata**, e non c'e analizzatore
che lo dica. E stata la scelta di scrivere i test prima a farlo emergere subito
invece che in esercizio.

#### Prova che nulla si e spostato

Il criterio di questo passo era che fosse un rifattorizzamento puro:

- il **CSV dei confini e identico byte per byte** dopo la rigenerazione
  (`a99a8c97…`);
- `app_meta` resta **5 `readDb` / 2 `writeDb`**;
- `unresolvedRouteCount` resta **0**;
- app-meta 5/5, process-topology + route-policy + orders-payments-invariants
  174/174, continuity + audit 71/71, gate route 8/8, gate architetturale 198
  route e 0 violazioni, baseline `ok: true`.

### 19.13 `app_meta` da 5 residui a 1

Chiusi quattro dei cinque:

| route | come |
|---|---|
| `appState.get` | `modules/app-state/app-state-model.js` → `readAppStateView` |
| `appState.sync` | idem → `syncAppStateView` |
| `health` | `modules/status/app-meta-model.js` → `resolveHealthSettingsVersion` |
| `monitor.overview` | idem → `readMonitorOverviewView` |

`app-state.handlers.js` scende da 113 a **42 righe**; `buildAppStatePayload` si
sposta nel modello insieme alle due route che la usavano.

Due cose conservate di proposito:

- **`appState.sync` scrive solo se qualcosa e cambiato.** Il ramo `if (changed)`
  evita di spostare `meta.lastWriteAt` a ogni sincronizzazione;
- **`resolveHealthSettingsVersion` porta nel modello tutta la scelta**, non la
  sola lettura: la versione arriva dallo snapshot di salute quando c'e, e solo
  altrimenti da `db.meta`. Spezzarla avrebbe lasciato al handler il compito di
  sapere *quando* serve l'app-state, che e esattamente cio che P2b toglie.

#### Perche `monitor.control` resta aperta

Il suo grappolo di funzioni locali e di **23 funzioni per 476 righe** — chiusura
transitiva misurata, non stimata — piu il corpo del handler. E un'estrazione
grande quanto quella della proiezione, e merita un passo suo.

Si sarebbe potuto far scendere il conteggio a zero dando al modello una funzione
che apre la lettura, passa `db` al handler e poi scrive. Il numero sarebbe
tornato e il criterio no: **P2b non chiede che il conteggio scenda, chiede che
l'app-state abbia un owner.** Con `db` che torna indietro al handler, l'owner
resta il handler.

#### Verifica

app-meta 5/5 · process-topology + route-policy + orders-payments-invariants +
continuity **243/243** · audit + catalog-commerce + notifiche + settings
room/table **18/18** · gate route 8/8 · architetturale 198 route e 0 violazioni ·
baseline `ok: true` · **CSV dei confini identico byte per byte** · entrambi gli
analizzatori di dipendenze a 0.

Stato dei domini: sei chiusi a 0/0 (46 route), `app_meta` a 1/1, e restano
`fiscal` (5/0), `crm` (7/4), `operations` (8/4), `reservations` (19/11),
`payments` (33/4), `sales` (27/16).

### 19.14 Dominio `fiscal` chiuso, e due 500 latenti scoperti per strada

`fiscal` a **0/0** su tutte e 5 le route: **ottavo dominio, 63 route sulle 198**.
`fiscal.handlers.js` scende da 167 a **15 righe**.

Qui la rete di test **non e stata scritta perche esisteva gia**:
`payment-weird-cases.e2e` esercita emissione, annullamento e verifica contro un
gateway fiscale finto, con asserzioni sugli esiti reali. I numeri prima e dopo
coincidono: 24/24 sulle suite fiscali, 47/47 su weird cases piu security.

Da conoscere:

- **`resolvePaymentsReportReadDb` e stata spostata nel modello e restituita ai
  handler**, perche era locale alla factory e la usano anche altre route: il
  composition root non avrebbe potuto passarla. E lo stesso schema della
  proiezione monitor;
- `payment-movement-fiscal-actions.test.mjs` **ritagliava le tre funzioni per
  offset** dal sorgente. Ora legge il modello. Conserva tutte le asserzioni di
  contenuto e quelle d'ordine **interne** a ogni fetta — che sono il contratto
  vero: `assertFiscalProviderRealMode` prima della chiamata al gateway, la
  chiamata prima di scrivere lo stato. Cade la sola asserzione sull'ordine fra i
  quattro handler: `reprint` e rimasta nei handler, quindi quell'ordine non
  esiste piu come fatto, e non era un contratto ma il modo di tagliare.

#### L'analizzatore, allargato una terza volta, ha trovato due 500 latenti

Estraendo `fiscal.command` e saltato fuori un 500:
`FISCAL_COMMAND_WRITE_SPLIT_DOMAINS is not defined`. E una `const` dichiarata
**dentro la factory** di `fiscal.handlers.js`, non esportata, rimasta indietro
mentre i suoi unici usi si spostavano. L'analizzatore diceva zero, perche il suo
insieme di nomi noti conteneva **solo gli export** dei moduli.

Allargato a **tutte le dichiarazioni a qualunque profondita** (7.851 nomi contro
2.626), piu la correzione di un falso positivo — `import.meta.url`, dove `meta`
veniva letto come identificatore. Con quell'insieme ha trovato subito **due
difetti reali gia in esercizio nel codice estratto ieri**, in
`monitor-control-model.js`:

- **`compactOrderItem`**: e fra le 27 funzioni che la proiezione restituisce, ma
  non veniva passata al modello. Sarebbe stato un 500 sul ramo che aggiorna gli
  articoli di una comanda;
- **`MONITOR_RESET_ALL_WRITE_DOMAINS`**: finita nella proiezione **per
  posizione** — era dentro l'intervallo di righe spostato — ma serve solo a
  `monitor.control`. Sarebbe stato un 500 su `reset_all_tables`.

**Nessuno dei due era coperto dalla rete di test di `app_meta`**, e per il
secondo la ragione era esplicita: il caso `reset_all_tables` era stato *escluso
di proposito* perche distruttivo. Lo era sul dataset reale, non sul fixture che
ogni test si crea da zero. Il caso e stato aggiunto, e verificato togliendo di
nuovo la costante: fallisce, e con la costante passa.

Tre allargamenti dell'analizzatore in due giorni, ognuno dopo un difetto vero:
intersezione con i soli nomi di `server.js`, poi con gli export di tutti i
moduli, ora con tutte le dichiarazioni. La lezione non e sul filtro ma sul
metodo: **ogni volta che il filtro ha nascosto qualcosa, se ne e accorto un
test o un avvio del server, mai l'analizzatore stesso.**

### 19.15 Il palmare: l'ipotesi di §10.4 era sbagliata, la causa era un'altra

**Va corretto quanto scritto in §10.4.** L'ipotesi era che la webapp integrata
non facesse piu l'handshake TLS e che le XHR verso il certificato self-signed
fallissero in silenzio. **Non era cosi**, e il 2026-09-04 il palmare si e
collegato **in HTTPS** senza toccare nulla del TLS.

La causa vera sta in `KioskPreferences.kt`:

```kotlin
private val LEGACY_V5BT_SERVER_URLS = setOf(
    "https://192.168.1.182:5380/mobile",
    "https://192.168.0.67:5380/mobile"   // <- l'indirizzo ATTUALE del Raspberry
)
```

Quella lista serve a scartare gli indirizzi di un server dismesso. Dentro c'era
**l'indirizzo attuale del Pi**. Cosi `resolveInitialKioskUrl`, a ogni avvio,
leggeva l'URL configurato a mano, lo riconosceva come "legacy", lo sostituiva
con `DEFAULT_SERVER_URL` — che a sua volta puntava a `192.168.1.79`, una rete
che non esiste piu — e **soprascriveva la preferenza salvata**.

L'effetto era esattamente quello osservato per due giorni: configurando l'URL il
palmare funzionava per quella sessione, e al riavvio tornava "Backend login non
raggiungibile" senza che nulla lo spiegasse. Anche il "reset dopo la
reinstallazione" di ieri era questo, non la perdita dei dati.

Corretti entrambi: l'indirizzo del Pi e uscito dalla lista legacy e
`DEFAULT_SERVER_URL` punta al Raspberry attuale. Verificato leggendo
`shared_prefs/webkiosk_prefs.xml` con `run-as` prima e dopo un riavvio: l'URL
adesso **sopravvive**, e il palmare entra e resta collegato.

**Lezione**: l'ipotesi di §10.4 era coerente con i fatti che avevo, ma i fatti
erano pochi. Bastava leggere le preferenze dell'app — `adb shell run-as
<package> cat shared_prefs/webkiosk_prefs.xml` su una build di debug — per
vedere subito che l'URL non era quello che avevo scritto.

### 19.16 Simulazione completa con la Postazione

E il pezzo che mancava alla campagna: finora le comande venivano fatte avanzare
a mano con `orders/sync`.

La Postazione si apre su `https://192.168.0.67:5380/postazione/`. Due cose da
sapere per pilotarla:

- **"Accedi" non e un click**: e una pressione prolungata di **2 secondi**
  (`HOLD_DURATION_MS`), gestita da `onPointerDown`/`onPointerUp`. Un `click()`
  non la fa scattare e la pagina sembra bloccata;
- dopo le credenziali chiede **quale postazione**: BAR PRINCIPALE (BAR-1) o
  CUCINA (BAR-2).

Il giro provato, con cassa e Postazione **aperte insieme**:

1. la cassa crea la comanda **#07444** sul Tavolo 5 — due articoli, 6,00 €,
   sul tavolo occupato poco prima con l'intolleranza al latte messa dalla
   modale nuova;
2. la **Postazione BAR-1** la riceve, la prende in carico ("In carico: Lorenzo
   B. - BAR-1", "IN PREPARAZIONE") e la segna **PRONTA**;
3. il cameriere la segna **Consegnato** dallo storico ordini del tavolo;
4. il tavolo diventa riscuotibile: compare **Riscuoti**.

Due cose imparate strada facendo:

- **senza una postazione collegata la cassa rifiuta di prendere comande**
  (`mobile-no-active-stations-backdrop`). Il primo tentativo e fallito proprio
  cosi, perche avevo chiuso il browser della Postazione: e il sistema che
  funziona, non un difetto;
- nello storico ordini **il click sulla riga apre la scheda della comanda** e
  copre il pulsante "Segna consegnato": va mirato il pulsante.

**Non e stato eseguito l'incasso** di questa comanda: la sessione del browser
perde la scelta del POS a ogni riapertura e andava rifatta. Il Tavolo 5 resta
consegnato e non pagato, 6,00 €, pronto per il punto 6 della campagna.

### 19.17 "Se faccio troppo velocemente non me lo segna": tre difetti, non uno

Segnalazione dall'esercizio: *«spesso se faccio troppo velocemente il passaggio
di segnare un'intolleranza ad un tavolo non me lo segna»*. Dietro c'erano **tre**
difetti distinti, tutti silenziosi — la scelta spariva senza un messaggio.

**1. Le intolleranze non erano nel confronto del salvataggio automatico.**
`useAnagraphicAutoSave` decide se c'e qualcosa da salvare guardando nome,
telefono, coperti e nota. Allergeni e intolleranza manuale non c'erano. Sul
tavolo che aveva **gia** il marcatore `ALLERGIE / INTOLLERANZE` in nota,
aggiungerne una seconda non muoveva nessuno dei campi guardati: il salvataggio
non partiva **mai**, per quanto si aspettasse. E questo il "spesso": dipendeva da
cosa il tavolo avesse gia.

**2. Il rinvio di 900 ms veniva annullato invece che eseguito.** Quando la nota
cambia davvero (prima intolleranza segnata, oppure ultima tolta) il salvataggio
parte 900 ms dopo. Chiudere il dettaglio o cambiare tavolo prima faceva scattare
la pulizia dell'effetto, che azzerava il timer. Questo e il "troppo
velocemente". Ora un salvataggio ancora in attesa viene **eseguito** alla
chiusura del pannello o al cambio di tavolo, non lasciato cadere.

**3. Lato server, un campo vuoto non voleva dire "cancella".** In
`handleIntegrationLayoutTableSync` la regola era
`requestedAllergens.length ? requestedAllergens : current.allergens`, e la stessa
forma per `manualIntolerance` e `note`. Un elenco vuoto veniva letto come
"nessuna richiesta" e si ricadeva sul valore gia salvato: **le intolleranze non
si potevano piu togliere** se non liberando il tavolo. La modale di conferma
cancellazione costruita ieri sembrava funzionare e al ricarico le pastiglie
tornavano tutte. Ora si distingue il campo **assente** (che continua a valere
"non toccare", ed e cio che protegge un tavolo da un client che sincronizza
senza conoscere l'anagrafica) dal campo **presente e vuoto**, che cancella.

Il terzo e emerso solo perche la verifica sul Pi partiva da uno stato sporco e
l'azzeramento non riusciva: senza quel passaggio sarebbe rimasto nascosto dietro
al primo.

**Non e un difetto**: il testo scritto nel campo manuale e non aggiunto con `+`
resta fuori dalla conferma. E voluto — il `+` e il gesto con cui quel campo si
conferma.

#### La rete

- `mobile-frontend/tests/anagraphicAutoSaveIntolerances.test.tsx` (7 casi, anche
  nell'albero del palmare): la seconda intolleranza con la nota ferma, la
  chiusura del pannello prima dei 900 ms, il cambio di tavolo, e i due casi che
  impediscono il salvataggio di troppo — nessuna modifica, e lo stesso elenco in
  ordine diverso;
- `cassa-frontend/backend/tests/table-sync-intolerance-clear.e2e.test.mjs`
  (3 casi): con i campi vuoti si cancella, senza quei campi non si tocca nulla,
  e si puo togliere **una sola** intolleranza lasciando le altre. Sul codice
  precedente 2 di questi 3 sono rossi.

#### Verifica sul Raspberry

Build della webapp mobile caricata sul Pi (copia di sicurezza in
`mobile-frontend-dist.baseline-20260904-145255`) e il solo
`room-change.handlers.js` sul backend — il file sul Pi era **identico byte per
byte** alla versione locale prima della correzione, quindi il trasferimento e
esattamente questa differenza e non si tira dietro le fette non ancora
consegnate (copia in `room-change.handlers.js.baseline-20260904-151123`).

Prova a video con Chrome, leggendo **dopo un ricarico** cosi cio che si vede
viene dal server:

| | build precedente | con la correzione |
|---|---|---|
| azzerare le intolleranze | non arriva al server | azzerato |
| segnare e chiudere il dettaglio dopo 150 ms | persa | salvata |
| seconda intolleranza, nota ferma | — | salvate entrambe |

**Da sapere per chi continua**: la finestra non e chiusa del tutto. Se un
aggiornamento del tavolo arriva dal server **mentre** ci sono modifiche non
salvate, l'effetto di risincronizzazione di `TablesWorkspace` (righe 955-988)
riscrive tutti i campi della bozza senza guardare se c'e qualcosa in sospeso.
Serve un cambiamento del tavolo lato server entro 900 ms, quindi e una finestra
stretta, ma il rimedio — una guardia sulle modifiche non salvate — resta da
fare.

Residuo di prova lasciato sul Pi: il **Tavolo 2** ha una comanda #07445 da
1,30 € creata per riprodurre il difetto. Le intolleranze di prova sono state
tolte.

---

## Riferimenti rapidi

| cosa | dove |
|---|---|
| Stato ufficiale della roadmap | `ROADMAP_V6/POSTGRESQL/V6_POSTGRESQL_MIGRATION_ROADMAP_REV2/MIGRATION_STATUS.md` |
| Architettura target (14 domini) | `ROADMAP_V6/POSTGRESQL/…/02_TARGET_ARCHITECTURE.md` |
| Decomposizione di `server.js` | `ROADMAP_V6/POSTGRESQL/…/14_SERVER_DECOMPOSITION.md` |
| Decisioni aperte | `ROADMAP_V6/POSTGRESQL/…/12_OPEN_DECISIONS.md` |
| Inventario dei confini | `SORGENTE_SISTEMA/cassa-frontend/reports/postgresql-migration/p2b/server-route-boundaries.csv` |
| Evidenza RET-01 | `…/reports/postgresql-migration/mig026/raspberry-dev-sd-ret01-approval-20260902.json` |
| Composition root | `SORGENTE_SISTEMA/cassa-frontend/backend/server.js` |
| Avanzamento per dominio | `SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration/p2b-domain-progress.mjs` |
| Icone originali | `RISORSE_GRAFICHE/icone-pagamento-originali/` |
| Handover precedente | `DOCUMENTAZIONE/HANDOVER_IA_STATO_20260902.md` |
