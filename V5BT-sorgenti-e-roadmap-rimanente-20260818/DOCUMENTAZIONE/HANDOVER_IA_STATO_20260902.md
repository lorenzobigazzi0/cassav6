# Handover IA — stato al 2026-09-03: quattro domini P2b a 0/0

Data: 2026-09-03 (supera la revisione del 2026-09-02)  
Root di lavoro: `D:\sistemacassav6\V5BT-sorgenti-e-roadmap-rimanente-20260818`

Supera i tre handover del 2026-09-01 (`…P2B3_USERS_LIST…`, `…P2B_SELECT_WORKSTATION…`,
`…P2B_AUTH_LOGIN…`), che restano come storico dei singoli slice.

## Dove siamo

Programma: migrazione PostgreSQL V6 (REV2). Stato ufficiale in
`ROADMAP_V6/POSTGRESQL/V6_POSTGRESQL_MIGRATION_ROADMAP_REV2/MIGRATION_STATUS.md`
— **non** in `DOCUMENTAZIONE/`.

| Fase | Stato |
|---|---|
| P0 baseline e inventario | IN_PROGRESS — MIG-002 e MIG-000 aperte |
| P1 infrastruttura PostgreSQL | IN_PROGRESS, gate `DEV_ONLY`; HW-01-PROD aperta |
| P2 foundation persistence | IN_PROGRESS, gate `DEV_ONLY` |
| **P2b decomposizione `server.js`** | **IN_PROGRESS — è qui che si lavora** |
| P3 … P15 | TODO, bloccate dal gate P2b |

Nessun percorso dati è commutato a PostgreSQL. Nessun cutover autorizzato.

## Slice identity: concluso

Tutte e sette le route identity sono a **zero `readDb`/`writeDb` diretti**
(erano 7 e 11). Un owner dell'app-state per route:

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
fra login, logout e session status. `users.save` non la usa di proposito: le sue
`deleteSession` sono attese e il fallimento lancia un 503 invece di restituire un
booleano, e l'ordine è asserito dai test.

`auth.handlers.js` da 819 a 188 righe con 12 dipendenze, `users.handlers.js` da
306 a 25 con 4. Copertura nuova: `auth-change-pin-handler` 7,
`auth-select-workstation-handler` 11, `auth-session-status-handler` 5,
`auth-login-handler` 17, `auth-logout-handler` 12, `user-app-users-handler` 15.

**Il gate del pilot è raggiunto, quello della fase P2b no**: MIG-031 chiede
`server.js` sotto 25.000 righe (oggi ~38.800) e MIG-032/033 valgono su tutti i
domini, non sulle sette identity.

## MIG-030: chiusa (DONE)

Inventario dei confini esteso da 7 a **198 route su 198** (193 handlerKey: cinque
servono più path). Quattro file nuovi in `SORGENTE_SISTEMA/cassa-frontend/scripts/postgresql-migration/`:

- `route-source-index.mjs` — analizzatore statico: `handlerKey → funzione →
  collezioni app-state`, seguendo il salto verso i write model iniettati dal
  composition root;
- `route-domain-map.mjs` — le 193 dichiarazioni, una riga per chiave;
- `p2b-route-boundaries.mjs` + `.test.mjs` — il gate, con gli script
  `migration:pg:p2b-routes` e `test:migration:pg:p2b-routes`.

Numeri dopo la revisione del 2026-09-02: 13 domini usati sui 14 di
`02_TARGET_ARCHITECTURE.md`, **89 route con cross-domain reale**, **124 che
attraversano un contenitore legacy**, 134 mutative, 144 che scrivono app-state,
**1 sola non risolvibile staticamente** (`health`, che non tocca nulla).

La revisione ha corretto due difetti dell'analizzatore — seguiva i sanitizer, che
non ricevono l'app-state e quindi non possono leggerlo, e consumava gli argomenti
perdendo le chiamate annidate — e ha separato due misure che erano confuse.
`posSettings` (130 route) e `integration` (63) nel legacy sono **contenitori
condivisi**: dentro convivono impostazioni, sale, tavoli, ordini e prenotazioni,
mentre le collezioni omonime sono quasi vuote (`orders` 2 route,
`rooms`/`tables`/`reservations` 1 ciascuna). Attribuirli a un dominio faceva
risultare cross-domain 175 route su 198, cioe' nulla. Ora stanno nella colonna
`legacyStores`, e **quel 124 e' la misura reale del lavoro che attende
MIG-032/033**: sciogliere quei due contenitori. Un test impedisce alla colonna
cross-domain di tornare satura.

Distribuzione: payments 52 · sales 34 · configuration 19 · reservations 19 ·
operations 18 · app_meta 15 · crm 8 · identity 7 · commerce 7 · catalog 6 ·
messaging 6 · fiscal 5 · audit 2.

**Regola del gate**: la dichiarazione è autoritativa, l'analisi statica fa da
rete. Il gate fallisce se deduce un accesso che la dichiarazione non prevede;
dichiarare di più è ammesso e va motivato in `note`, perché l'analisi non
attraversa le iniezioni a metodo. Quattro route mutative sono state corrette a
mano proprio per questo (`appState.reset`, il flush ordini asincrono e i due
mirror dello spool di stampa).

## Dominio `configuration`: chiuso (2026-09-03)

Secondo dominio a **0 `readDb` e 0 `writeDb`** diretti dopo identity, da 19/10 su
19 route. Cinque modelli nuovi, 824 righe:

| modello | route |
|---|---|
| `modules/settings/settings-read-model.js` | 4 letture |
| `modules/settings/settings-write-model.js` | 7 scritture + `saveOrderWorkflow` |
| `modules/radio/radio-read-model.js` | 2 letture |
| `modules/radio/radio-write-model.js` | 2 scritture |
| `modules/status/configuration-read-model.js` | 3 letture di stato |

`settings.handlers.js` scende da 657 a 313 righe, `radio.handlers.js` da 209 a 128.

Tre cose da sapere per i domini successivi:

- **le route di stato non sono come le altre**: leggono con
  `allowMigrations: false`, **non validano la sessione** e prendono le
  impostazioni da `menuSettingsRepository` con fallback sull'app-state. Tutte e
  tre le differenze sono conservate nel reader dedicato;
- **`settings.saveOrderWorkflow` e uscita anche da `server.js`** portandosi
  dietro verbatim l'effetto cross-domain sugli ordini: auto-consegna dei pronti,
  audit `order.auto_delivered_by_workflow_setting`, sync finanziario dei tavoli.
  La suite che lo copre e `order-delivery-confirmation.e2e`;
- le cinque scritture di `settings` hanno la stessa sequenza ma **non sono state
  accorpate** in un helper parametrico: differiscono per messaggio del 403, fetta
  di payload e origine della notifica, e un accorpamento sbagliato si vedrebbe
  tardi. L'accorpamento resta un lavoro a se, se mai servira.

**Con identity, P3 ha entrambe le sue meta a 0/0.**

## Domini `catalog` e `commerce`: chiusi (2026-09-03)

Terzo e quarto dominio a **0 `readDb` e 0 `writeDb`** diretti. `catalog` da 5/1
su 5 route, `commerce` da 8/6 su 7. Quattro modelli nuovi, 1.034 righe:

| modello | route |
|---|---|
| `modules/menu/menu-read-model.js` | catalogo, suggerimenti, menu integrazione, piu venduti |
| `modules/menu/menu-write-model.js` | `settings.menu`, entrambi i rami |
| `modules/commercial-benefits/commercial-benefits-read-model.js` | elenco campagne |
| `modules/commercial-benefits/commercial-benefits-write-model.js` | le sei route che mutano |

`menu.handlers.js` scende da 701 a 372 righe, `integration-menu.handlers.js` da
153 a 44, `commercial-benefits.handlers.js` da 970 a 602 (restano gli aiutanti
puri, ora esportati per i modelli). `integration.menuTopSold` e uscita anche da
`server.js`.

Quattro cose che non vanno perse:

- **`settings.menu` e una route a due rami, non due route.** Senza `items` nel
  payload si comporta da lettura e ritorna presto; solo altrimenti verifica
  `manage_menu` e scrive. Nel write model resta **una sola funzione** con il suo
  ritorno anticipato: spezzarla avrebbe inventato una route che non esiste;
- **`readIntegrationMenuView` dichiara anche come inviare la risposta.** La cache
  veloce conserva il JSON gia serializzato, quindi il reader ritorna `json` per
  il corpo gia stringa e `payload` per l'oggetto, e il handler resta il solo a
  scegliere fra `sendJsonString` e `sendJson`. E l'unica differenza rispetto al
  codice di partenza;
- **la doppia lettura di `printCoupon` e voluta.** Legge, accoda il job di stampa
  -- un effetto esterno -- e solo dopo rilegge in `latestDb` per non sovrascrivere
  cio che l'accodamento ha nel frattempo scritto. Collassare le due letture
  farebbe sparire il job **senza che nulla fallisca**: per questo
  `backend/tests/catalog-commerce.e2e.test.mjs` (`npm run test:catalog-commerce`)
  verifica che il job sopravviva alla scrittura successiva;
- il contesto di autenticazione gia risolto dal middleware (`req.__authContext`)
  arriva ai modelli di `commerce` come secondo argomento, con lo stesso fallback
  su `validateSessionContext` di prima. Lo stato **201** di `createCampaign`
  resta nel handler: appartiene alla route, non alla regola.

Nuovo strumento: `scripts/postgresql-migration/p2b-domain-progress.mjs` stampa
l'avanzamento P2b per dominio. Il conteggio e **a profondita zero** di proposito
-- il criterio non e che il dominio smetta di leggere l'app-state, ma che a
farlo sia un modello e non il handler HTTP.

Stato dopo questo slice:

| dominio | route | `readDb` | `writeDb` |
|---|---:|---:|---:|
| identity, configuration, catalog, commerce | 38 | **0** | **0** |
| audit | 2 | 2 | 1 |
| messaging | 6 | 3 | 0 |
| fiscal | 5 | 5 | 0 |
| app_meta | 12 | 4 | 2 |
| crm | 8 | 7 | 4 |
| operations | 18 | 8 | 4 |
| reservations | 19 | 19 | 11 |
| payments | 51 | 33 | 4 |
| sales | 34 | 27 | 16 |

## Raspberry DEV — stato al 2026-09-02

Host `raspberrypi`, `192.168.0.67`, aarch64, 4 GiB. PostgreSQL 17 e MariaDB
entrambi attivi; disco 58 GB con 41 GB liberi (28% usato), invariato dopo
l'intervento di oggi.

**Accesso**: utente `admin` con password, fornita dal proprietario. L'accesso a
chiave non è configurato: `ssh` con `BatchMode` viene rifiutato per ogni utente
provato. Sul Windows di sviluppo non c'è `sshpass`; ci sono `plink` e `paramiko`.
Conviene autorizzare una chiave pubblica sul Pi e smettere di passare password.

**Porte**: 5381 backend (`/api/health` → 200, `database.mode: "mysql"`), 5380
frontend HTTPS (302), 22 SSH, 5432 filtrata — PostgreSQL resta locale, ed è
corretto così.

**Nessun percorso dati è commutato a PostgreSQL**: il backend gira ancora su
MariaDB. Le migration PostgreSQL preparano lo schema, non lo usano.

Registro migrazioni applicate: **001 → 007**. La 007 (approvazione RET-01) è
stata applicata oggi, due volte, dopo backup logico (sha256 `3f5ca421…`, 198.388
byte) e restore di prova su database temporaneo (13 righe, 129 ms, nessun
residuo). Esito: 8 policy approvate, **0 abilitate**, 0 ancora `TODO`, 5
legalmente protette intatte, runtime `SELECT=true`/`UPDATE=false`,
`audit.events` partizionata con 16 partizioni.

Staging usato: `/home/admin/cassav6-ret01-20260902a`, copiato da quello della
006 e integrato con i file nuovi. Gli staging precedenti (`cassav6-mig006-*`)
sono ancora lì.

Per applicare una migration successiva basta ripetere lo stesso percorso:
backup, restore di prova, poi

```bash
sudo RET01_ALLOW_DEV_APPLY=1 \
  /home/admin/<staging>/scripts/postgresql-migration/apply-ret01-dev-sd.sh /home/admin/<staging>
```

Attenzione: le postcondizioni dello script devono ricevere host, utente e
database dall'env del runner. La prima versione chiamava `psql` senza parametri
e falliva con `role "root" does not exist` — la migration era già andata a buon
fine, ma il controllo finale no. Corretta il 2026-09-02.

## Da dove ripartire

1. **MIG-031: lavoro sugli handler concluso, soglia non perseguita.**
   `server.js` è passato da 38.831 a **31.371** righe (−7.460, −19%) con
   diciannove blocchi estratti, tutti spostamenti verbatim. Oggi è a **31.434**:
   i modelli di dominio di MIG-032/033 aggiungono cablaggio al composition root
   mentre tolgono righe ai moduli, ed è il compromesso previsto. In `server.js`
   restano **10 handler per 284 righe** in tutto, isolati: estrarli costerebbe
   dieci cicli per ~130 righe nette, quindi si è deciso di fermarsi.

   **La soglia di 25.000 della DoD è stata valutata e scartata**, non dimenticata.
   Gli helper rimasti sono funzioni *hoisted* referenziate a metà file; spostarle
   in una factory le rende `const` in temporal dead zone. Sul blocco fiscale la
   finestra di collocazione è **vuota**, misurata: primo uso a riga 12.387, ma
   `readDb` è definita a 16.466 e `findPosFiscalReceiptByPaymentId` a 21.340.
   Siccome `readDb`/`writeDb` stanno a ~16.500 e servono a quasi ogni helper,
   ogni blocco referenziato prima di quella riga ha lo stesso problema.

   **Questo non blocca MIG-032/033**, e va detto chiaro a chi legge la catena di
   dipendenze del CSV: il pilot identity le ha portate a 0/0 su sette route con
   `server.js` ancora a 38.800 righe. La dipendenza formale MIG-032 → MIG-031 è
   una euristica su "quanto è scomposto il monolite", non un vincolo tecnico.

   Se si vorrà riprendere, la tecnica praticabile è la **facciata hoisted con
   risoluzione pigra**: un guscio `function` in `server.js` che dereferenzia il
   modulo al momento della chiamata invece che all'inizializzazione. Immune alla
   TDZ per costruzione, costa ~3 righe per funzione esportata (sul blocco fiscale:
   90 righe di gusci al posto di 1.839, netto −1.750). L'unica verifica per blocco
   è che nessuna di quelle funzioni venga invocata durante l'inizializzazione del
   modulo, dove nemmeno il guscio pigro salverebbe.

2. **MIG-032/033** — reader e writer scoped su tutti i domini. Quattro chiusi
   (identity, configuration, catalog, commerce: 38 route su 198), nove aperti.
   L'ordine finora ha seguito le fasi della roadmap e la dimensione; i prossimi
   piccoli sono `audit` (2/1), `messaging` (3/0), `app_meta` (4/2) e `fiscal`
   (5/0), poi `crm` (7/4) e `operations` (8/4). Restano per ultimi i tre grandi:
   `reservations` (19/11), `sales` (27/16, 17 file) e `payments` (33/4).
   `npm run migration:pg:p2b-routes` rigenera l'inventario e
   `node scripts/postgresql-migration/p2b-domain-progress.mjs` la tabella qui
   sopra. La misura del lavoro di fondo resta il 124 di `legacyStores`:
   sciogliere `posSettings` e `integration`.

## Pacchetto consegnato

`CassaV6-software-e-aggiornamento-P2B-MIG030-MIG031-20260902.zip` in
`D:\sistemacassav6`, 203 MB, 4.361 file.

SHA-256: `2eda237123fc1e84fbcc3f3764cb88212d8357e9772ef9ea172083c353e8b717`
(anche in `.zip.sha256` accanto all'archivio).

Contiene lo stato descritto qui: pilot identity chiuso, MIG-030 completata,
diciannove blocchi di MIG-031 estratti, RET-01 decisa e applicata al Raspberry.
`ARCHIVE_INFO.json` riporta i checksum dei documenti chiave e l'esito dei test;
`CONTENUTO_PACCHETTO.md` ha la sezione con le novita di questo pacchetto.

Esclusi come da convenzione: `node_modules`, `build`, `dist`, cache Gradle,
APK/AAB, `.rollback`, `.runtime`, log e credenziali. Il filtro e stato validato
confrontando l'elenco con il pacchetto precedente: stessi 4.308 file piu le 51
novita di oggi, nessuna assenza.

## Verifica corrente

Da `SORGENTE_SISTEMA/cassa-frontend`, tutto verde al 2026-09-02:

```powershell
npm run test:migration:pg:p2b-routes      # 8/8
npm run test:migration:pg:p2b-identity    # 3/3
npm run test:migration:pg:p2b-baseline    # 4/4
npm run gate:migration:pg:p2b-baseline    # comparison.ok: true
npm run gate:architecture-security        # 198 route, 0 violazioni, server.js 31.434
npm run test:catalog-commerce             # 2/2, include la stampa buono end-to-end
node scripts/postgresql-migration/p2b-domain-progress.mjs   # avanzamento per dominio
node --test --test-concurrency=1 backend/tests/continuity.e2e.test.mjs   # 69/69
node --test --test-concurrency=1 backend/tests/auth-session.e2e.test.mjs # 25/25
```

Evidenze rigenerabili: `reports/postgresql-migration/p2b/server-route-boundaries.csv`,
`route-boundaries-baseline-20260902.json`, `identity-route-boundaries.csv`,
`identity-pilot-baseline-20260901.json`.

## Aperti

- **Attivazione delle policy di retention** — è l'unica cosa che tiene aperta
  MIG-026. RET-01 è decisa e la 007 è applicata, ma nessuna policy è `enabled`.
  L'abilitazione è una `UPDATE` esplicita, una policy alla volta, e ha senso solo
  quando la tabella esiste davvero: sei delle otto riguardano tabelle non ancora
  create e delle due esistenti `audit.events` è vuota. Serve prima uno scheduler
  che invochi le purge fuori dagli orari di servizio: oggi non esiste. Evidenza
  dello stato attuale in
  `reports/postgresql-migration/mig026/raspberry-dev-sd-ret01-approval-20260902.json`.
- **MIG-002** e **MIG-000**: P0 non è chiusa.
- **MIG-013**: backup e PITR misurati solo su un database vuoto; il drill con
  dataset reale e il backup su storage indipendente restano da fare.
- **SEQ-01** (Commerciale V2 vs migrazione) va chiusa prima di P4.
- **Attivazione Postazione**: `posSettings.workstations` è vuoto e lorenzo ha
  `workstationIds: []`. Due scritture di settings, in attesa di via libera.
- **Campagna di test POS** su palmare reale (ordini, resi, sconti, pagamenti,
  carte sconto, cambi sala/tavolo, unioni, carichi/scarichi): interrotta.
- Il workspace non è gestito con Git e **un'altra sessione ha lavorato in
  parallelo** su questo stesso pilot (lo slice `auth.sessionStatus` è suo).
  Prima di modificare un file, ricontrollare che sia nello stato descritto qui.
  Checkpoint e ZIP solo a slice concluso e verificato.
