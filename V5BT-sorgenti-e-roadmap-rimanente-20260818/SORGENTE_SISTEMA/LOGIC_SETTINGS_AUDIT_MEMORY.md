# Memoria audit logica e impostazioni

Data ciclo: 2026-06-05 03:30 Europe/Rome

## Obiettivo

Verificare altri bug nella logica e nelle impostazioni, con focus su:

- modello Locale -> Attivita -> Sale -> Tavoli;
- postazioni reali;
- stampanti e RT;
- menu/listini/routing articoli;
- utenti e permessi;
- notifiche, pause e presenza camerieri;
- prenotazioni;
- bridge/mock/fallback residui.

## Test e controlli eseguiti

- `node backend/scripts/audit-room-permissions.mjs`: OK.
- `node --test backend/tests/audit-room-permissions.test.mjs backend/tests/configuration-save-contract.test.mjs backend/tests/load-balancer-station-eligibility.test.mjs backend/tests/waiters-routing.e2e.test.mjs`: OK, 13/13.
- `node --test backend/tests/settings-room-table-policy.e2e.test.mjs backend/tests/station-availability-alerts.e2e.test.mjs backend/tests/station-pause-transfer.e2e.test.mjs`: OK, 8/8.
- `node --test backend/tests/no-fiscal-auto-paid-user-static.test.mjs`: OK, 2/2.
- `node --test backend/tests/operational-context-alias.test.mjs backend/tests/configuration-snapshot.test.mjs`: KO, 7/8; unico failure snapshot legacy con `precontoPrinterIds`.
- `node --test backend/tests/waiter-pauses.test.mjs backend/tests/notifications-priority.e2e.test.mjs backend/tests/notifications-persistence.e2e.test.mjs`: OK, 7/7.
- `node --test backend/tests/reservations-multi-table-static.test.mjs backend/tests/reservations-status.e2e.test.mjs backend/tests/settings-room-table-policy.e2e.test.mjs`: OK, 9/9.
- `npx vitest run tests/static/stationAvailabilityModal.test.ts tests/static/serviceRecoveryAndFiscalFlows.test.ts tests/static/serviceRecoveryModalVisual.test.ts tests/notificationCenterSession.test.tsx`: OK, 7/7.
- `npx vitest run tests/static/noRuntimeMockCopy.test.ts tests/static/mobileLegacyBridgeAssets.test.ts tests/static/v1BridgeNativeMigration.test.ts tests/static/paymentMethodPermissionsNative.test.ts tests/static/dashboardQuickFilter.test.ts tests/static/tablesRoomsHotRefresh.test.ts`: OK, 10/10.
- `node --test frontend-tests/monitor-configuration-static.test.mjs frontend-tests/postazione-bridges.test.mjs frontend-tests/mobile-frontendv2-static.test.mjs`: OK, 33/33.
- `node scripts/validate-static-frontends.mjs && node scripts/validate-static-dist.mjs`: OK.

## Findings confermati

### P1 - Routing menu/postazioni non configurato sugli articoli

Stato rilevato:

- `menuItems`: 166.
- Articoli con `stations/stationIds/workstationIds`: 0.
- Categorie `posSettings.menus[0].categories[*].stationIds/workstationIds`: tutte vuote.

Impatto:

- le comande cocktail/premium non possono risolvere nativamente `BAR-1`;
- i test backend falliscono con `routeStations: [""]` invece di `["BAR-1"]`;
- la configurazione "per ogni postazione scegli menu/categorie/articoli" non e' ancora realmente applicata al catalogo.

Test collegati falliti nel ciclo precedente:

- `backend/tests/orders-flow.e2e.test.mjs`;
- `backend/tests/security.test.mjs`.

### P1 - Retry fiscale schedulato non avanza

Stato rilevato:

- i test base pagamento/fiscale e ristampa passano;
- i test dedicati al retry fiscale prima/dopo le 05:00 falliscono per timeout.

Impatto:

- se il fiscale e' KO e torna online prima delle 05:00, il sistema non dimostra il recupero automatico;
- il report non fiscalizzati passa, quindi la reportistica esiste ma il worker/trigger di retry va corretto.

### P1 - Cambio tavolo profondo con ordine/stampe torna 400

Stato rilevato:

- i test GUI cambio tavolo base passano;
- il test backend profondo `table move updates digital order, prints update tickets, and manual reprint uses updated table` ritorna 400 invece di 200.

Impatto:

- il cambio tavolo operativo complesso non e' ancora robusto come V1/V2 atteso.

### P2 - Duplicati attivi nel menu

Duplicati attivi trovati:

- `Hendrick's`
  - `menu_drink_premium_hendrick_s`;
  - `menu_drink_premium_hendricks`.
- `N°3`
  - `menu_drink_premium_n_3`;
  - `menu_drink_premium_n3`.

Impatto:

- ricerca/comanda puo' mostrare 2 risultati per lo stesso prodotto;
- conferma il caso visto su mobile con ricerca Hendrick's.

### P2 - Articoli attivi orfani dal menu strutturato

Stato rilevato:

- `menuItems`: 166.
- prodotti referenziati dalle categorie `menu_main`: 125.
- articoli attivi orfani: 41.

Esempi:

- `Tassoni`;
- `Hugo Spritz`;
- `Caffe Macchiato`;
- `Acqua Brillante`;
- vari drink classici;
- vecchi duplicati `Hendrick's` e `N°3`.

Impatto:

- un articolo puo' essere trovato dalla ricerca piatta ma non comparire nella categoria;
- oppure puo' apparire doppio se UI/API fondono flat catalog e menu strutturato.

### P2 - Postazioni richieste non presenti nel DB

Postazioni attuali:

- `BAR-1`;
- `BAR-2`;
- `PIZZA IN RIVA`.

Postazioni richieste ma assenti:

- `CHIRINGUITO-1`;
- `CHIRINGUITO-2`;
- `MOBILE`.

Impatto:

- configurazione/load balancing/routing verso queste postazioni non puo' funzionare finche' non vengono persistite in `posSettings.workstations` e collegate ad attivita/sale.

### P2 - Costanti hardcoded Pizza in Riva / Francesca nel monolite

Rilevato in `cassa-frontend/backend/server.js`:

- `NO_FISCAL_AUTO_PAID_USER_IDS`;
- `NO_FISCAL_AUTO_PAID_USERNAMES`;
- `PIZZA_IN_RIVA_ROOM_ID`;
- `PIZZA_IN_RIVA_USER_ID`;
- `PIZZA_IN_RIVA_PRECONTO_PRINTER_ID`;
- host stampante `192.168.1.36`.

Impatto:

- la policy funziona nei test, ma non e' ancora pienamente modellata da impostazioni/DB;
- rischio regressione quando si modifica l'architettura locale/attivita/sala/stampanti.

### P2 - Storico stampa punta a stampante non configurata

Stato rilevato:

- `printSpoolJobs`: 49.
- tutti `printed`.
- tutti puntano a `printer_bar_principale_1921681127_9100`.
- stampanti configurate attuali:
  - `printer_bar_1921681195_9100`;
  - `printer_pizza_in_riva_192168136_9100`.

Impatto:

- lo storico/monitor puo' mostrare una stampante non piu configurata;
- eventuali ristampe basate su vecchio `printerId` potrebbero non risolvere la stampante corrente.

### P2 - Pagamenti storici con utente rinominato non riallineato

Stato rilevato:

- 3 pagamenti puntano ancora a:
  - `createdByUserId: u_niccolo`;
  - `collectedByUserId: u_niccolo`;
  - `createdByUsername: niccolo`;
  - `collectedByUsername: niccolo`.
- l'utente corrente e' `bardo`; non esiste `u_niccolo` nel DB utenti corrente.

Impatto:

- statistiche/scarico per utente possono non associare quei pagamenti all'utente rinominato;
- serve alias storico o migrazione refs.

### P2 - Policy impostazioni non ancora persistite come modello esplicito

Chiavi non presenti direttamente in `posSettings` o DB:

- `mobileDevices`;
- `notificationPolicies`;
- `notificationPriorityPolicies`;
- `breakPolicies`;
- `staffAssignments`;
- `roomStaffAssignments`;
- `roomMenuAssignments`;
- `printerAssignments`.

Nota:

- alcuni dati sono derivati correttamente da utenti/aree;
- per la nuova UI impostazioni serve pero' persistenza esplicita, altrimenti l'amministrazione resta parziale.

### P3 - Snapshot legacy non allineato a `precontoPrinterIds`

Failure:

- `configuration snapshot espone una configurazione legacy come locale operativo pubblicato`.

Causa:

- lo snapshot legacy ora include `precontoPrinterIds: []`;
- il test expected storico non lo include.

Da decidere:

- se `precontoPrinterIds` e' parte del contratto pubblico, aggiornare il test;
- se non deve apparire in legacy, filtrarlo nel serializer legacy.

## Controlli passati importanti

- Nessun riferimento rotto tra aree, utenti, stampanti, RT, postazioni e attivita.
- Gazebo configurata e autorizzazioni utenti attivi OK.
- Tavoli:
  - `Bar`: 10;
  - `Gazebo`: 25;
  - `Pedana`: 20;
  - `Pizza in Riva`: 1;
  - `Spiaggia`: 26;
  - `Terrazza`: 25;
  - `Attesa virtuale`: 10.
- Nessun tavolo duplicato per sala/numero.
- Nessun tavolo con sala inesistente.
- Operational context:
  - `activity_bar + room_gazebo + BAR-1` risolve correttamente stampante bar e RT bar;
  - `activity_bar + room_pizza_in_riva` viene correttamente rifiutato;
  - `activity_pizza_in_riva + room_pizza_in_riva + PIZZA IN RIVA` risolve stampante Pizza in Riva e nessuna RT.
- Francesca:
  - `fiscalExcluded: true`;
  - `fiscalPolicy: no_fiscal_auto_paid`;
  - `autoPaidNoFiscal: true`;
  - test dedicati OK.
- Prenotazioni multi-tavolo/status/release: test OK.
- Notifiche persistenti, priorita e pausa: test OK.
- Mobile bridge/mock/fallback statici: test OK.
- Frontend statici: validazione asset OK.

## Priorita proposta

1. Sistemare routing menu/postazioni e collegare categorie/articoli a postazioni reali.
2. Deduplicare `Hendrick's` e `N°3` e riallineare i 41 articoli orfani nel menu strutturato.
3. Rendere Pizza in Riva/Francesca configurabile da DB, togliendo costanti operative dal monolite.
4. Aggiungere `CHIRINGUITO-1`, `CHIRINGUITO-2`, `MOBILE` come postazioni reali se ancora richieste.
5. Sistemare retry fiscale prima/dopo 05:00.
6. Migrare/riallineare riferimenti pagamenti `niccolo -> bardo` oppure introdurre alias storico.
7. Normalizzare storico print spool o gestire alias stampante vecchia -> nuova per monitor/ristampa.
8. Persistire in impostazioni policy mobile devices, pause, notifiche e assegnazioni invece di derivarle soltanto.

## Limiti del ciclo

- Nessuna modifica applicativa applicata.
- Nessun riavvio.
- Nessuna stampa fisica reale.
- Nessuna emissione fiscale reale.
