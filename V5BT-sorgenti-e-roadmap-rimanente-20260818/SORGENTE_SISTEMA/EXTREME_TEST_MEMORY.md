# Memoria test estremi e simulazioni GUI reali

Data ciclo: 2026-06-05 Europe/Rome

## Obiettivo

Costruire una memoria stabile per migliaia di test funzionali, grafici, state-machine,
boundary e caos operativo sul sistema POS.

Questa memoria serve per:

- sapere cosa simulare anche dopo un riavvio o cambio operatore;
- evitare test casuali non ripetibili;
- separare test eseguibili ora dai test da ripetere con fiscale fisico attivo;
- guidare test con frontend reali, GUI reale, touch, mouse, multi-device e stampante;
- tracciare casi limite non ancora emersi in servizio.

## Stato ambiente del ciclo

- Root progetto: `/srv/applicazione/current`
- Frontend reali disponibili:
  - mobile: `/mobile/`
  - cassa: `/cassa/`
  - postazione: `/postazione/`
  - impostazioni: `/impostazioni/`
- Runner GUI reale disponibile:
  - `cassa-frontend/playwright.config.mjs`
  - `mobile-frontend/playwright.config.ts`
- Test GUI esistenti:
  - `cassa-frontend/e2e/gui-boundary-matrix.spec.mjs`
  - `cassa-frontend/e2e/gui-boundary-maxisimulation.spec.mjs`
  - `cassa-frontend/e2e/gui-complex-workflows.spec.mjs`
  - `cassa-frontend/e2e/gui-expanded-regression.spec.mjs`
  - `cassa-frontend/e2e/gui-listino-time-pricing.spec.mjs`
  - `cassa-frontend/e2e/gui-operational-flows.spec.mjs`
  - `cassa-frontend/e2e/gui-scenario-workflow.spec.mjs`
  - `cassa-frontend/e2e/gui-ultra-workflows.spec.mjs`
  - `cassa-frontend/e2e/mobile-cassa-postazione.spec.mjs`
- Fiscale fisico: indicato come disattivato/non disponibile.
- Regola fiscale del ciclo:
  - non emettere fiscalita' reale;
  - testare KO, retry, coda non fiscalizzati, visibilita' esito fiscale, non duplicazione;
  - ripetere emissione reale quando RT/fiscale torna disponibile.

## Principi non negoziabili

- Usare frontend reali con Playwright quando possibile.
- Simulare touch reale con context mobile `isMobile: true` e `hasTouch: true`.
- Non usare mock applicativi se il backend reale di test e' disponibile.
- Ammesso fake TCP printer nei test isolati, per verificare spool e payload senza usare carta reale.
- Se si usa stampante reale, dichiarare il batch come `REAL_PRINT`.
- Fiscale fisico spento: il test deve aspettarsi KO/retry, non successo.
- Non cancellare dati live senza esplicita richiesta.
- Non aggiornare soglie architetturali per nascondere debito.
- Ogni failure deve essere classificata:
  - bug runtime;
  - bug grafico;
  - bug state-machine;
  - bug test harness;
  - dipendenza/ambiente;
  - flakiness/concorrenza;
  - fiscale fisico indisponibile.

## Copertura generativa totale

La matrice seguente produce migliaia di scenari senza doverli scrivere tutti a mano.

### Assi GUI

| Asse | Valori | Note |
|---|---:|---|
| Frontend | 4 | mobile, cassa, postazione, impostazioni |
| Tema | 2 | diurno, notturno |
| Viewport mobile | 6 | 360x740, 390x844, 412x915, 430x932, landscape, tablet |
| Input | 4 | tap, long-press, swipe, keyboard/mouse |
| Connettivita' | 5 | online, backend slow, backend offline, postazione offline, waiter offline |
| Utenti | 8+ | admin, responsabile, operatori, utente Pizza in Riva, utenti senza permessi |
| Sale | 8+ | Pedana, Sala, Terrazza, Gazebo, Bar 1, Bar 2, Pizza in Riva, Attesa virtuale |
| Stato tavolo | 12 | libero, occupato, ordinato, in prep, pronto, pagato parziale, pagato, prenotato soft, prenotato effettivo, bloccato, unito, spostato |
| Tipo ordine | 14 | semplice, varianti obbligatorie, supplementi, note, comanda lunga, item duplicati, item non catalogo, reso, sostituzione, storno, modifica, annullo, riordino, ordine senza postazioni |
| Pagamento | 10 | conto unico, alla romana, importo libero, articolo, POS KO, POS retry, contanti, misto, scarico, ristampa |

Combinazioni teoriche principali: 4 x 2 x 6 x 4 x 5 x 8 x 8 x 12 x 14 x 10 = 2.580.480.

Queste non vanno tutte lanciate integralmente ogni volta. Si campionano con batch P0/P1/P2/P3 sotto.

## Catalogo batch prioritari

### BATCH-P0-SMOKE-REAL-GUI

Scopo: verificare che i frontend reali carichino e che non ci siano crash immediati.

ID coperti:

- GUI-P0-0001: mobile carica da browser touch.
- GUI-P0-0002: cassa carica da browser desktop.
- GUI-P0-0003: postazione carica da browser desktop.
- GUI-P0-0004: impostazioni carica da browser desktop.
- GUI-P0-0005: login mobile crea sessione backend.
- GUI-P0-0006: cassa e postazione non ereditano sessione mobile.
- GUI-P0-0007: asset JS/CSS/immagini non hanno 404.
- GUI-P0-0008: nessun fallback stanze statico runtime.
- GUI-P0-0009: batteria mobile chiama backend anche senza deviceUuid.
- GUI-P0-0010: backend health e route proxy rispondono.

Runner consigliato:

```bash
cd /srv/applicazione/current/cassa-frontend
npm run test:gui -- --grep "frontend statici|login mobile"
```

### BATCH-P1-ORDINI-STATE-MACHINE

Scopo: proteggere workflow comande e regressioni.

Range generativo: `ORD-SM-0001` -> `ORD-SM-0200`.

Copertura:

- create -> waiting;
- waiting -> prep;
- prep -> ready;
- ready -> delivered/paid;
- cancel da waiting;
- cancel da prep;
- modifica da waiting;
- modifica da prep;
- modifica da ready non pagata;
- blocco modifica su pagata;
- retry create con idempotency;
- sync stale ignorato;
- sync regressivo auditato;
- alias ordine 272/00272/#272;
- ordine con prodotto duplicato;
- ordine con variante obbligatoria mancante;
- ordine con supplementi;
- ordine con note lunghe;
- ordine con caratteri speciali;
- ordine con prodotto non catalogo;
- ordine con totale client vecchio.

Runner consigliato:

```bash
cd /srv/applicazione/current/cassa-frontend
node --test backend/tests/order-state-machine.test.mjs backend/tests/orders-payments-invariants.test.mjs
npm run test:gui -- --grep "ORD-"
```

### BATCH-P1-PAGAMENTI-FISCALE-SPENTO

Scopo: pagamenti e fiscale con RT fisicamente spento.

Range generativo: `PAY-FISCAL-OFF-0001` -> `PAY-FISCAL-OFF-0300`.

Aspettative:

- POS settled non deve sparire se fiscale KO.
- POS deve conservare transazione e tentare retry entro cutoff.
- Contanti, se fiscalita' abilitata per RT ma servizio KO, devono entrare in non fiscalizzati.
- Ristampa non deve riemettere.
- Dettaglio pagamento deve mostrare `Esito Fiscale: KO` quando KO.
- A fine sessione/scarico deve apparire report non fiscalizzati.
- Nessuna duplicazione incasso.
- Nessuna regressione stato pagato -> unpaid.
- Nessun fallback su RT di altra attivita'.

Runner consigliato:

```bash
cd /srv/applicazione/current/cassa-frontend
node --test backend/tests/payment-weird-cases.e2e.test.mjs backend/tests/payments-fiscal.e2e.test.mjs
```

Nota: con fiscale fisico spento, eventuali test che aspettano emissione OK reale devono essere marcati `SKIP_REAL_FISCAL`.

### BATCH-P1-STAMPA-SPOOL

Scopo: verificare routing stampanti e spool.

Range generativo: `PRINT-0001` -> `PRINT-0400`.

Copertura:

- stampa comanda;
- stampa preconto completo;
- stampa preconto attuale;
- stampa pagamento;
- stampa storno;
- stampa sostituzione;
- stampa cancellazione tavolo admin;
- test stampa impostazioni;
- printer offline;
- printer wrong activity;
- printer missing;
- retry spool dopo rete;
- no fallback su stampanti non configurate;
- routing sala/attivita/postazione/categoria/articolo;
- Pizza in Riva non riceve preconti Bar;
- Bar non riceve stampe Pizza in Riva.

Runner consigliato:

```bash
cd /srv/applicazione/current/cassa-frontend
npm run test:gui -- --grep "print|stampa|preconto|storno"
```

### BATCH-P1-POSTAZIONE

Scopo: comande, pause, chiamate cameriere e load balancing postazione.

Range generativo: `STATION-0001` -> `STATION-0500`.

Copertura:

- login postazione con postazioni da DB;
- nessuna postazione mock;
- due utenti non possono stare su stessa postazione;
- postazione undefined mai visibile;
- pausa chiede trasferimento se esistono destinazioni;
- pausa mantiene coda se non esistono destinazioni;
- cambio stato immediato waiting/prep/ready;
- massimo 3 prep con check;
- selezione nuova comanda rimette waiting quella senza check;
- chiamata cameriere disabilitata se waiter offline;
- ack cameriere mostra `HA RISPOSTO - STA ARRIVANDO`;
- cleanup chiamata dopo ack;
- active waiters con finestra presenza meno stringente;
- trasferimento verso postazioni realmente attive.

Runner consigliato:

```bash
cd /srv/applicazione/current/cassa-frontend
node --test frontend-tests/postazione-bridges.test.mjs backend/tests/station-pause-transfer.e2e.test.mjs
```

### BATCH-P1-PRENOTAZIONI

Scopo: multi-sala, multi-tavolo, finestre 30/15/5 minuti.

Range generativo: `RES-0001` -> `RES-0400`.

Copertura:

- prenotazione singolo tavolo;
- prenotazione multi-tavolo;
- piu prenotazioni stesso tavolo con gap minimo 1 ora;
- arrivo;
- no show;
- elimina una sola volta;
- liberazione prenotato;
- tavolo occupato entro -30 min non butta fuori operatore;
- tavolo libero entro -30 min diventa prenotato effettivo;
- tavolo liberato dentro finestra diventa subito prenotato;
- ritardo >30 min chiede rimanda 10 min o libera;
- rilascio ridivide tavoli uniti;
- badge prenotazione soft;
- contrasto badge diurno/notturno.

Runner consigliato:

```bash
cd /srv/applicazione/current/cassa-frontend
node --test backend/tests/reservations-status.e2e.test.mjs backend/tests/reservations-multi-table-static.test.mjs
cd /srv/applicazione/current/mobile-frontend
npm run test -- --run tests/static/reservationsMultiTable.test.ts tests/static/reservationReleaseDecisionPrompt.test.ts tests/static/reservationsTableSelectionVisual.test.ts
```

### BATCH-P1-MOBILE-MODALI-USABILITA

Scopo: modali diurno/notturno, altezza, contrasto, touch.

Range generativo: `MODAL-0001` -> `MODAL-0700`.

Copertura:

- dettaglio tavolo;
- modifica comanda;
- premodale modifica/cancella;
- reso/storno/sostituzione;
- pagamento;
- dettaglio pagamento;
- statistiche;
- cambio sala;
- sposta tavolo;
- unisci tavoli;
- prenotazione;
- pausa cameriere;
- avviso postazione chiusa;
- variante obbligatoria;
- drink premium;
- cambio PIN;
- long-press paga/preconto;
- X visibile in alto a destra;
- scroll interno modale, non pagina;
- card non tagliate;
- scrollbar invisibile quando richiesto;
- contrasto prezzo in night mode.

Runner consigliato:

```bash
cd /srv/applicazione/current/mobile-frontend
npm run test -- --run tests/static/*Modal*.test.ts tests/static/dashboardDarkMode.test.ts
```

### BATCH-P2-CHAOS-MULTI-DEVICE

Scopo: simulare giornata piena e disconnessioni.

Range generativo: `CHAOS-0001` -> `CHAOS-1000`.

Assi:

- 4 palmari;
- 2 postazioni;
- 30 tavoli;
- 50+ ordini;
- 100+ transazioni;
- camerieri online/offline/in pausa;
- postazioni online/offline/in pausa;
- stampante online/offline;
- backend slow;
- reload pagina;
- logout/login;
- scarico sessione;
- cambio sala mentre ordini o pagamenti aperti;
- unione/divisione tavoli durante resi;
- modifica e storno su comande pagate;
- prenotazioni che arrivano durante servizio.

Runner consigliato:

```bash
cd /srv/applicazione/current/cassa-frontend
npm run test:gui -- --grep "MAX|ULTRA|SCENARIO|COMPLEX"
```

### BATCH-P2-IMPOSTAZIONI-ARCHITETTURA

Scopo: locale/attivita/sale/stampanti/RT/postazioni/personale.

Range generativo: `SETTINGS-0001` -> `SETTINGS-0600`.

Copertura:

- locale Amalia Laghi;
- attivita Bar;
- attivita Pizza in Riva;
- RT solo su attivita;
- stampanti su attivita;
- stampanti su sala;
- postazioni su attivita;
- postazioni con menu/categorie/articoli;
- personale assegnato a sala;
- priorita ordine/consegna/ritiro;
- toggle demo mode;
- palmari: batteria, fiscale abilitato, POS/contanti, squillo;
- test stampa formattato da impostazioni;
- salvataggio senza refresh brutale;
- mobile riceve hot refresh sale/tavoli;
- nessun fallback hardcoded.

Runner consigliato:

```bash
cd /srv/applicazione/current/cassa-frontend
node --test backend/tests/menu-settings.e2e.test.mjs backend/tests/relational-menu-settings.test.mjs backend/tests/settings-room-table-policy.e2e.test.mjs
```

### BATCH-P3-BOUNDARY-VALORI

Scopo: input estremi, prezzi, quantita', testi.

Range generativo: `BOUNDARY-0001` -> `BOUNDARY-1200`.

Valori:

- quantita': 0, 1, 2, 999, 1000, -1, 0.5;
- prezzo: 0, 0.01, 1.30, 999.99, -1, stringa, NaN;
- note: vuote, 1 char, 2000 char, emoji, apostrofi, virgolette, accenti, newline;
- nomi prodotto: duplicati, SKU assente, K, gin, vodka, spazi multipli;
- orari: 07:59, 08:00, 17:59, 18:00, 23:59, 00:00, 04:59, 05:00;
- date prenotazioni: oggi, ieri, domani, cambio mese, DST;
- rete: timeout, retry, body vuoto, JSON invalido;
- auth: token scaduto, deviceUuid mancante, utente in pausa, logout/login;
- concorrenza: doppio tap, long press + tap, doppio pagamento, doppia cancellazione.

Runner consigliato:

```bash
cd /srv/applicazione/current/cassa-frontend
npm run test:gui -- --grep "BOUNDARY"
cd /srv/applicazione/current/mobile-frontend
npm run test -- --run tests/orderEmissionPricing.test.ts tests/paymentBackendPayload.test.ts tests/paymentArticleUnits.test.ts
```

## Sequenza di esecuzione consigliata per un giro completo

1. `P0 smoke GUI reali`.
2. `Backend release gate`.
3. `Postazione bridge/state`.
4. `Mobile static modali/tema`.
5. `GUI operational flows`.
6. `GUI boundary matrix`.
7. `GUI complex workflows`.
8. `GUI ultra/max simulation`.
9. `Impostazioni e routing configurazione`.
10. `Fiscale spento: KO/retry/non fiscalizzati`.
11. `Stampa/spool con fake TCP o reale se autorizzata`.
12. Report finale e aggiornamento memoria.

## Comandi master

```bash
cd /srv/applicazione/current/cassa-frontend
npm run check:backend
npm run test:backend:release
node --test frontend-tests/postazione-bridges.test.mjs
npm run test:gui

cd /srv/applicazione/current/mobile-frontend
npm run typecheck
npm run test
npm run build
npm run test:e2e
```

## Stato corrente del ciclo

| Batch | Stato | Note |
|---|---|---|
| BATCH-P0-SMOKE-REAL-GUI | Da eseguire nel ciclo corrente | Usa Playwright e frontend reali isolati |
| BATCH-P1-ORDINI-STATE-MACHINE | Da eseguire nel ciclo corrente | Gia' coperto in parte dai test backend release |
| BATCH-P1-PAGAMENTI-FISCALE-SPENTO | Da eseguire senza emissione reale | Fiscalita' fisica off: aspettarsi KO/retry dove reale |
| BATCH-P1-STAMPA-SPOOL | Da eseguire con fake TCP o reale autorizzata | Evitare fallback stampante |
| BATCH-P1-POSTAZIONE | Da rieseguire | Include pausa postazione corretta nel ciclo precedente |
| BATCH-P1-PRENOTAZIONI | Da rieseguire | Include multi-tavolo e release |
| BATCH-P1-MOBILE-MODALI-USABILITA | Da rieseguire | Diurno/notturno, altezza, contrasto |
| BATCH-P2-CHAOS-MULTI-DEVICE | Da campionare | Non lanciare milioni di combinazioni in un unico run |
| BATCH-P2-IMPOSTAZIONI-ARCHITETTURA | Da rieseguire | Sale, RT, stampanti, postazioni, personale |
| BATCH-P3-BOUNDARY-VALORI | Da campionare | Valori limite e input strani |

## Risultati da aggiornare dopo il run

Compilare dopo ogni ciclo:

| Data/Ora | Comando | Esito | Failure | Classificazione | Azione |
|---|---|---|---|---|---|
| 2026-06-05 02:56 CEST | `npm run test:gui` | OK: 109/109 Playwright real GUI passati in 12.6m | 0 finali | GUI reale simulata, touch/mobile/postazione/stampa TCP fake | Suite completa rieseguita dopo fix |
| 2026-06-05 02:56 CEST | `npm run check:backend` | OK | 0 | Sintassi backend/server.js e serve-frontends | Nessuna azione |
| 2026-06-05 02:56 CEST | `npm run test:backend:release` | OK | 0 | Backend release gate: sicurezza, listini, menu, print utils, batteria, pagamenti/fiscalita', ristampa | Nessuna azione |
| 2026-06-05 02:56 CEST | `node --test frontend-tests/postazione-bridges.test.mjs` | OK: 24/24 | 0 | Bridge postazione/sessione/modale/storico/chiamata cameriere | Nuovi test aggiunti |
| 2026-06-05 02:56 CEST | `npx playwright test ... gui-scenario-workflow` | OK | 0 | Scenario multisala con modifiche, resi, spostamenti, unioni, pagamenti e stampe | Verificato fix routing stampa |
| 2026-06-05 02:56 CEST | `npx playwright test ... gui-boundary-maxisimulation` | OK | 0 | Boundary max: totale >999, storno pagato, pausa postazione, unione, sostituzione, saldo | Verificato fix warning postazione |

## Ciclo eseguito 2026-06-05

### Obiettivo del ciclo

Simulare quante piu' evenienze possibili con frontend reali in Playwright, inclusi touch mobile, postazione, modali, stati, stampa TCP di test, boundary e casi non lineari. Il fiscale fisico e' considerato disattivato/non affidabile nel ciclo: sono stati verificati i flussi software, i retry/idempotenza e la non duplicazione, non l'emissione fiscale reale.

### Esito iniziale

Prima delle correzioni la suite GUI completa aveva prodotto:

- 99 test passati su 109.
- 10 failure totali.
- Cluster principali:
  - avviso postazione non attiva non restituito dopo il nuovo routing/load-balancer;
  - 401 console da frontend postazione anonimo su endpoint protetti;
  - stampa scenario multisala bloccata da `PRINTER_NOT_AVAILABLE` per sala payload non coerente con sala comanda.

### Correzioni applicate nel ciclo

- `cassa-frontend/backend/server.js`
  - `pausedStationWarning` viene calcolato dopo `applyIntegrationAutoAssignment()`, quindi riflette l'assegnazione reale e non la vecchia postazione primaria.
  - `withOrderPrintOperationalRoutingPayload()` preferisce la `roomId` salvata sulla comanda rispetto alla sala corrente del device quando stampa/ristampa una comanda.

- `postazione/dist/assets/postazione-login-session-bridge.js`
  - `POST /api/auth/session/status` senza `token/userId/deviceUuid` non chiama il backend e restituisce localmente `valid:false`.

- `postazione/dist/assets/postazione-station-modal-options-fix.js`
  - la modale selezione postazione non chiama `/api/settings/pos` senza sessione autenticata;
  - prima del login usa solo `/api/integration/stations/state` per popolare la lista postazioni.

- `cassa-frontend/frontend-tests/postazione-bridges.test.mjs`
  - aggiunti test su session status senza sessione;
  - aggiunto test su modale postazione anonima che non deve chiamare impostazioni protette.

- `cassa-frontend/e2e/gui-ultra-workflows.spec.mjs`
  - corretto il setup del test ultra per spegnere le sessioni reali `u_ultra_manager` e `u_ultra_admin`, non l'operatore sintetico predefinito.

### Test mirati rieseguiti

- `node --check backend/server.js`: OK.
- `node --test frontend-tests/postazione-bridges.test.mjs`: OK, 24/24.
- `npx playwright test --config playwright.config.mjs e2e/gui-boundary-matrix.spec.mjs --grep "POS-01"`: OK.
- `npx playwright test --config playwright.config.mjs e2e/gui-complex-workflows.spec.mjs --grep "postazione in pausa|postazione riattivata"`: OK.
- `npx playwright test --config playwright.config.mjs e2e/gui-ultra-workflows.spec.mjs --grep "GUI-ULTRA.*05|rientro postazione"`: OK.
- `npx playwright test --config playwright.config.mjs e2e/gui-expanded-regression.spec.mjs --grep "postazione|isolation"`: OK, 4/4.
- `npx playwright test --config playwright.config.mjs e2e/gui-scenario-workflow.spec.mjs --grep "flusso reale multisala"`: OK.
- `npx playwright test --config playwright.config.mjs e2e/gui-boundary-maxisimulation.spec.mjs`: OK.

### Suite complete rieseguite

- `npm run test:gui`: OK, 109/109.
- `npm run check:backend`: OK.
- `npm run test:backend:release`: OK.

### Coperture importanti confermate

- GUI mobile reale simulata con viewport touch e navigazione tab.
- Login, reload sessione, isolamento localStorage tra mobile/cassa/postazione.
- Widget batteria: percentuale, soglia rossa/verde, fulmine, match per device/nome/IP.
- Menu: ricerca `K`, gin/vodka, varianti/note, listino runtime backend source of truth.
- Ordini: alias numerici, modifica, annullo, revisioni stale, coda postazione, comande pronte.
- Pagamenti: parziali, quote, importo libero, per articolo, idempotency key, residuo dopo reload.
- Resi/storni/sostituzioni: quantita limite, articolo gia pagato, STORNO, sostituzione a zero, avviso quando non ci sono piu' articoli stornabili.
- Tavoli: lock multi-device, spostamento sala, cambio tavolo, unione, divisione, tavolo complesso.
- Stampa: comanda/preconto, ristampe, cambio tavolo, cambio sala, routing sala della comanda.
- Postazione: caricamento senza asset 404/console error, stati attivi, notifiche, pausa/rientro.
- Backend gate: sicurezza route, header, CORS, token query disabilitati in produzione, listini, menu, print utils, batteria, pagamenti/fiscalita' software, ristampa fiscale senza duplicare.

### Limiti del ciclo

- Non e' stata eseguita emissione fiscale fisica reale: il ciclo assume fiscale fisico disattivato.
- La stampa e' stata validata con fake TCP printer nei test GUI, non con stampante fisica reale.
- La matrice teorica di milioni di combinazioni non e' stata eseguita integralmente; e' stata campionata con suite boundary/complex/ultra/max.
- Non sono stati rieseguiti in questo ciclo `mobile-frontend npm run typecheck/test/build`, perche' il focus era GUI reale e backend release gate.

## Rischi residui noti prima del run

- `mobile-frontend npm run test` aveva storicamente un gate LOC aperto su 6 file grandi; rieseguirlo nel prossimo ciclo se si tocca mobile sorgente.
- Fiscale fisico spento: non si puo' validare emissione reale OK, solo fallback/KO/retry/non duplicazione software.
- Test GUI massivi possono richiedere tempo e risorse; usare batch, non matrice completa milionaria.
- Se si usa stampa reale, puo' produrre tagliandi fisici: marcare esplicitamente `REAL_PRINT`.
- Resta da fare un ciclo separato con stampante reale e fiscale reale quando il sistema fisico sara' disponibile.

## Prossimi step automatici

1. Se si tocca mobile sorgente, rieseguire `cd mobile-frontend && npm run typecheck && npm run test && npm run build`.
2. Preparare un ciclo `REAL_PRINT` con stampante fisica autorizzata.
3. Preparare un ciclo `REAL_FISCAL` quando RT/API fiscale e' fisicamente disponibile.
4. Continuare decomposizione monolite senza reintrodurre fallback stampanti/RT.
5. Mantenere questa memoria aggiornata a ogni ciclo lungo.

---

## Ciclo test aggiuntivo - 2026-06-05 03:07 CEST

### Obiettivo

Eseguire un ulteriore giro di test non distruttivo dopo il ciclo GUI/backend precedente, includendo frontend cassa, preflight, audit/gate architetturali, mobile typecheck/test/build/lint e backend completo.

### Esiti sintetici

- `cassa-frontend npm run test:frontend`: OK, 64/64.
- `cassa-frontend npm run audit:architecture-security`: OK, nessun finding bloccante.
- `mobile-frontend npm run typecheck`: OK.
- `mobile-frontend npm run build`: OK.
- `mobile-frontend npm run test:e2e`: OK, nessun test Playwright presente ma comando passato con `--pass-with-no-tests`.
- `cassa-frontend npm run test:backend`: KO, 409/420 passati, 11 falliti.
- `mobile-frontend npm run test -- --reporter=dot`: KO, 131/132 passati, 1 gate LOC fallito.
- `mobile-frontend npm run lint`: KO, prevalentemente per `legacy-mobile-assets` archiviati che ESLint tratta come runtime browser senza globals.
- `cassa-frontend npm run preflight:source`: KO per layout di deploy root non coincidente con layout archivio atteso.
- `cassa-frontend npm run preflight:package`: KO per stesso motivo del preflight source.
- `cassa-frontend npm run gate:architecture-security`: KO per budget monolite `backend/server.js` 29170 righe > 27500.

### Failure funzionali da correggere

1. `backend/tests/configuration-snapshot.test.mjs`
   - Test: `configuration snapshot espone una configurazione legacy come locale operativo pubblicato`.
   - Problema: snapshot attuale include `precontoPrinterIds: []`, test legacy non aggiornato o contratto snapshot cambiato senza allineamento.
   - Tipo: compatibilita contratto/config snapshot.

2. `backend/tests/continuity.e2e.test.mjs`
   - Test: `40 station pause state clears after heartbeat returns online`.
   - Problema: atteso `paused === false`, ricevuto `undefined`.
   - Tipo: normalizzazione stato pausa postazione non completa.

3. `backend/tests/listino-time-pricing.e2e.test.mjs`
   - Test: `[BE][LISTINO-16] prezzo ordine resta quello delle 17:30 anche se pagato e stampato alle 18:30`.
   - Problema: timeout in attesa stampa listino temporizzato.
   - Tipo: flusso stampa/preconto su ordine con prezzo congelato da verificare.

4. `backend/tests/orders-flow.e2e.test.mjs`
   - Test: `[BE][P0] creazione ordine con variante salva delta e routing cocktail`.
   - Problema: routing atteso `BAR-1`, ricevuto vuoto.
   - Tipo: risoluzione postazione/categoria/variante.

5. `backend/tests/pos-fiscal-retry.e2e.test.mjs`
   - Test: `riprende ricevuta POS FAILED retryable senza duplicare documenti gia emessi`.
   - Problema: retry fiscale non osservato entro timeout.
   - Tipo: retry fiscale software.

6. `backend/tests/pos-fiscal-retry.e2e.test.mjs`
   - Test: `ritenta emissione fiscale finche il server torna ok prima delle 05:00`.
   - Problema: retry fiscale non osservato entro timeout.
   - Tipo: retry fiscale software.

7. `backend/tests/pos-fiscal-retry.e2e.test.mjs`
   - Test: `non ritenta dopo la finestra delle 05:00 e marca la ricevuta scaduta`.
   - Problema: stato scaduto/non retry non osservato entro timeout.
   - Tipo: finestra fiscale 05:00.

8. `backend/tests/security.test.mjs`
   - Test: `premium alcohol requires a valid enabled variant and preserves selection`.
   - Problema: routing atteso `BAR-1`, ricevuto vuoto.
   - Tipo: routing drink premium/varianti.

9. `backend/tests/security.test.mjs`
   - Test: `premium alcohol catalog is exposed and premium variants price/route to real bar station`.
   - Problema: routing atteso `BAR-1`, ricevuto vuoto.
   - Tipo: catalogo premium e routing postazione reale.

10. `backend/tests/security.test.mjs`
    - Test: `table move updates digital order, prints update tickets, and manual reprint uses updated table`.
    - Problema: endpoint ritorna 400 invece di 200.
    - Tipo: cambio tavolo con ordine/stampe.

### Failure gate/debito tecnico

- `mobile-frontend npm run test -- --reporter=dot`
  - Gate LOC fallito su:
    - `src/api/tables.ts` 2743 > 2697.
    - `src/pages/home/reservations/ReservationsWorkspace.tsx` 1857 > 1829.
    - `src/pages/home/tables/components/TableDetailPanel.tsx` 1482 > 1375.
    - `src/pages/home/tables/TablesWorkspace.tsx` 1827 > 1773.
    - `src/pages/payments/PaymentSettlementSection.tsx` 1536 > 1388.
    - `src/pages/home/hooks/useNotificationCenter.ts` 660 > 628.

- `mobile-frontend npm run lint`
  - Molti errori provengono da `legacy-mobile-assets/assets/*.js`, trattati da ESLint come sorgenti runtime senza globals browser.
  - Warning sorgente da valutare separatamente: unused `cloneState`, unused eslint-disable, hook dependency warnings, uso hook dentro handler in `SettingsPage.tsx`.

- `cassa-frontend npm run gate:architecture-security`
  - Fallisce per budget monolite: `backend/server.js` 29170 righe > 27500.
  - Audit architetturale comunque OK senza finding bloccanti.

- `cassa-frontend npm run preflight:source` e `npm run preflight:package`
  - Falliscono perche' il deploy root corrente non contiene il layout archivio atteso (`v2/app/...`, README/report/checklist/inventory richiesti).
  - Da rieseguire sul package finale o riallineare gli script al layout corrente.

### Priorita suggerita di correzione

1. Retry fiscale: garantire retry su fiscal receipt retryable fino alle 05:00 e report non fiscalizzati fuori finestra.
2. Routing postazione reale per cocktail/premium variants: evitare `stationId` vuoto e usare configurazione DB, non fallback.
3. Cambio tavolo con ordine/stampe: ripristinare comportamento V1/V2 atteso senza blocco 400.
4. Prezzo congelato e stampa: assicurare che il preconto/pagamento usi snapshot prezzo ordine, non listino corrente.
5. Stato pausa postazione: normalizzare sempre `paused` a booleano.
6. Snapshot config: decidere se `precontoPrinterIds` fa parte del contratto pubblico legacy e aggiornare test o serializer.
7. Gate tecnici: riduzione monolite, split mobile file grandi, lint exclude/normalizzazione legacy assets.

### Note operative

- Non sono state applicate correzioni in questo ciclo: e' stato un ciclo di rilevazione.
- Non e' stata usata stampante fisica reale.
- Non e' stata emessa fiscalita' fisica reale.
- I test fiscalita' software di base e weird payment flows passano, inclusi POS 1 cent e ristampa senza duplicazione, ma il retry fiscale schedulato non passa.

---

## Ciclo test mirati aggiuntivi - 2026-06-05 03:16 CEST

### Obiettivo

Continuare i test dopo il ciclo ampio, confermando i failure backend uno per uno e aggiungendo batch GUI/mobile per distinguere regressioni funzionali da debito architetturale.

### Backend failure rieseguiti isolati

- `node --test backend/tests/configuration-snapshot.test.mjs`
  - Esito: KO, 6/7 passati.
  - Failure riproducibile: snapshot legacy espone `precontoPrinterIds: []` in piu' rispetto all'expected.

- `node --test backend/tests/continuity.e2e.test.mjs`
  - Esito: KO, 66/68 passati.
  - Failure riproducibile: `40 station pause state clears after heartbeat returns online`, `paused` risulta `undefined` invece di `false`.
  - Nota: il filtro `--test-name-pattern` non esercita correttamente il sottotest, mentre il file completo riproduce il bug.

- `node --test backend/tests/listino-time-pricing.e2e.test.mjs`
  - Esito: KO, 15/16 passati.
  - Failure riproducibile: `[BE][LISTINO-16] prezzo ordine resta quello delle 17:30 anche se pagato e stampato alle 18:30`.
  - Diagnosi test: timeout in attesa del job stampa listino temporizzato; i resolver prezzo/listino dei test 1-15 passano.

- `node --test backend/tests/orders-flow.e2e.test.mjs`
  - Esito: KO, 4/5 passati.
  - Failure riproducibile: variante cocktail salva flusso ma routing stampa/postazione atteso `BAR-1`, ottenuto `stationId` vuoto.

- `node --test backend/tests/pos-fiscal-retry.e2e.test.mjs`
  - Esito: KO, 1/4 passati.
  - Failure riproducibili:
    - retry ricevuta POS failed retryable;
    - retry finche' il server fiscale torna ok prima delle 05:00;
    - stop retry/scadenza dopo finestra 05:00.
  - Passa: report scarico non fiscalizzati POS/contanti fuori finestra.

- `node --test backend/tests/security.test.mjs`
  - Esito: KO, 24/27 passati.
  - Failure riproducibili:
    - premium alcohol requires a valid enabled variant and preserves selection: `stationId` vuoto invece di `BAR-1`;
    - premium alcohol catalog is exposed and premium variants price/route to real bar station: `stationId` vuoto invece di `BAR-1`;
    - table move updates digital order, prints update tickets, and manual reprint uses updated table: endpoint ritorna 400 invece di 200.

### GUI aggiuntiva

- `npx playwright test --config playwright.config.mjs e2e/gui-operational-flows.spec.mjs e2e/gui-listino-time-pricing.spec.mjs e2e/mobile-cassa-postazione.spec.mjs`
  - Esito: OK, 25/25.
  - Coperture confermate:
    - ricerca K, gin/vodka;
    - listino runtime letto da backend;
    - ordine browser reale con variante/note;
    - pubblicazione ordine su comande pubbliche;
    - postazione pronta rende pagabile;
    - pagamento parziale e residuo tavolo;
    - pagamento articolo con residui;
    - libera tavolo pagato;
    - cambio tavolo base;
    - ristampa comanda/preconto base;
    - unione/divisione tavoli;
    - modifica comanda e blocco revisione vecchia;
    - annullamento comanda;
    - esaurito/riabilitato.

### Mobile aggiuntivo

- `npx vitest run tests/*.test.ts tests/*.test.tsx`
  - Esito: OK, 16 file, 69/69.

- `find tests/static -type f -name '*.test.ts' ! -name 'architectureRules.test.ts' -print0 | xargs -0 npx vitest run`
  - Esito: OK, 24 file, 51/51.
  - Nota: escluso solo il gate LOC `architectureRules.test.ts`, gia' noto come fallimento della suite completa.

### Lettura tecnica aggiornata

- I flussi GUI base e mobile funzionali sono stabili in questo ciclo.
- I problemi backend riproducibili sono concentrati su:
  1. retry fiscale schedulato/finestra 05:00;
  2. routing postazione reale per varianti premium/cocktail;
  3. cambio tavolo con ordine/stampe su caso profondo;
  4. job stampa listino con prezzo congelato al momento ordine;
  5. normalizzazione pausa postazione;
  6. contratto snapshot configurazione legacy.

### Priorita prossimo ciclo di fix

1. Correggere routing postazione reale, perche' impatta ordini cocktail/premium e puo' causare stampa mancante o destinazione vuota.
2. Correggere retry fiscale schedulato, perche' impatta recupero operativo dopo fiscale KO.
3. Correggere cambio tavolo con ordine/stampe 400, per coerenza V1/V2.
4. Correggere job stampa listino congelato, per evitare mismatch ordine/pagamento/preconto su cambio fascia.
5. Normalizzare `paused` a booleano su heartbeat/rientro.
6. Allineare snapshot config legacy a `precontoPrinterIds` o rimuoverlo dal legacy serializer se non deve essere pubblico.

### Limiti

- Nessuna stampante fisica reale usata.
- Nessuna emissione fiscale fisica reale usata.
- Nessun fix applicato in questo ciclo; solo conferma e approfondimento.
