# Memoria problemi da risolvere

Data ciclo: 2026-06-05

## Regole operative del ciclo

- Correggere per radice, non con hardcode puntuali.
- Non introdurre fallback silenziosi su stampanti, RT o postazioni: se la configurazione e' mancante o incoerente deve emergere un errore chiaro.
- Ogni fix deve essere testato almeno con check/build o test mirato.
- Aggiornare questo file a ogni chiusura o cambio stato.

## Problemi aperti

| ID | Area | Sintomo | Ipotesi iniziale | Stato |
|---|---|---|---|---|
| P-001 | Fiscale POS | I pagamenti non emettono fiscale | RT/fiscal device non risolto dal contesto operativo o demo/abilitazioni RT incoerenti | Chiuso nel ciclo: `normalizePosFiscalDeviceJobConfig()` ora usa il fallback `POS_FISCAL_API_BASE_URL` anche quando il device sanitizzato ha `apiBaseUrl` vuoto. Test POS/cash fiscale OK. |
| P-002 | Sessioni postazione | Due utenti possono coesistere sulla stessa postazione, es. due su BAR-1 | Mancanza lock esclusivo utente-postazione o sessioni postazione non invalidate | Chiuso nel ciclo: login postazione risolve alias configurati e blocca utenti diversi sulla stessa postazione con `WORKSTATION_ALREADY_IN_USE`. |
| P-003 | Pausa cameriere | Il counter parte con circa 2 secondi in piu' | Differenza tra `remainingMs` server e ricalcolo client su `endsAtMs` | Chiuso nel ciclo: UI usa floor/remaining server invece di arrotondare per eccesso. |
| P-004 | Pausa cameriere | Stop pausa riazzera il residuo invece di mantenerlo | Backend stop chiude ciclo e rigenera disponibilita' da renewal invece di congelare consumo residuo | Chiuso nel ciclo: stop pausa conserva `remainingAllowanceMs` e resume lo consuma nello stesso ciclo. |
| P-005 | Home mobile -> tavoli | Il filtro delle 4 card home non filtra i tavoli | Possibile bundle non aggiornato o restore UI che sovrascrive ancora filtro | Chiuso nel ciclo: quick filter forza anche `setTableFilterMode("single")`; build mobile rigenerata. Da monitorare su device reale. |
| P-006 | Stampa mobile | Ogni stampa mobile dice `Postazione non collegata all'attivita operativa corrente` | Payload stampa non porta `activityId`/`workstationId`, oppure resolver richiede workstation anche per stampe di attività/sala | Chiuso nel ciclo: alias postazione robusti e stampe mobile/preconto/cancellazione tavolo inviano `ignoreWorkstationRouting` per routing da attività/sala. Da monitorare su device reale. |
| P-007 | Statistiche pagamenti | Da dettaglio pagamento, `Stampa` non ristampa il fiscale | API frontend chiama stampa normale o backend non trova ricevuta fiscale/id fiscale | Chiuso nel ciclo: i job di ristampa fiscale includono ora `fiscalDevice`; test ristampa fiscale OK senza riemissione. |
| P-008 | Profilo postazione | Nel profilo postazione compaiono toggle auto-stampa comanda/preconto non richiesti | Bridge `postazione-auto-print.js` inietta una card operativa dentro la modale profilo | Chiuso nel ciclo: pannello profilo disabilitato e testato, mantenendo le guardie tecniche dello script. |
| P-009 | Pausa postazione | La modale pausa/trasferimento a volte non si apre | La logica dipendeva solo dal `change` DOM del toggle; alcuni render React inviano direttamente lo stato | Chiuso nel ciclo: la pausa esplicita da client postazione apre la modale anche senza evento `change`; test aggiunto. |
| P-010 | Architettura mobile | `npm run test` mobile fallisce sul budget LOC di 6 file grandi | Debito di decomposizione accumulato su file monolitici mobile | Aperto: non aggiornare le soglie al rialzo. Prossimo step sicuro: decomporre per slice `tables.ts`, `TableDetailPanel`, `TablesWorkspace`, `PaymentSettlementSection`, `ReservationsWorkspace`, `useNotificationCenter`. |

## Verifiche eseguite

- Avviata analisi sorgente su `server.js`, `operational-context.js`, `WaiterPauseCard.tsx`, API ristampa e filtro dashboard.
- `node --test backend/tests/payment-weird-cases.e2e.test.mjs`: OK, copre emissione POS 0,01, contanti fiscale API e ristampa fiscale senza duplicare.
- `node --test backend/tests/operational-context-alias.test.mjs backend/tests/waiter-pauses.test.mjs backend/tests/auth-session.e2e.test.mjs backend/tests/payment-weird-cases.e2e.test.mjs`: OK.
- `npm run check:backend`: OK.
- `npm run test:backend:release`: OK dopo allineamento del test route-policy alla route pubblica mutativa già giustificata `POST /api/integration/waiter-pause/defer-call`.
- `node --test frontend-tests/postazione-bridges.test.mjs`: OK.
- `npm run test -- --run tests/static/dashboardQuickFilter.test.ts tests/static/serviceRecoveryAndFiscalFlows.test.ts`: OK.
- `npm run typecheck` e `npm run build` in `mobile-frontend`: OK, `dist` rigenerato.
- `node --test frontend-tests/postazione-bridges.test.mjs`: OK 22/22 dopo fix pausa/profilo.
- `node --test backend/tests/station-pause-transfer.e2e.test.mjs backend/tests/payment-provider-state-machine.test.mjs backend/tests/order-state-machine.test.mjs backend/tests/orders-payments-invariants.test.mjs`: OK 18/18.
- `npm run test:backend:release`: OK.
- `npm run test -- --run tests/static/dashboardQuickFilter.test.ts`: OK 2/2.
- `npm run test -- --run tests/static/architectureRules.test.ts`: KO solo su budget LOC dei file grandi, endpoint grezzi React invece rientrati.
- `npm run test` in `mobile-frontend`: KO solo per budget LOC; 131/132 test passati.
- `npm run test -- --run tests/static/dashboardDarkMode.test.ts tests/static/stationAvailabilityModal.test.ts tests/static/tableMoveModalVisualParity.test.ts tests/static/serviceRecoveryModalVisual.test.ts tests/static/analyticsPaymentDetailModal.test.ts tests/static/reservationsTableSelectionVisual.test.ts tests/static/premiumDrinkVariantModal.test.ts`: OK 18/18.
- `node --test backend/tests/load-balancer-station-eligibility.test.mjs backend/tests/settings-room-table-policy.e2e.test.mjs backend/tests/station-availability-alerts.e2e.test.mjs backend/tests/menu-settings.e2e.test.mjs backend/tests/relational-menu-settings.test.mjs backend/tests/reservations-status.e2e.test.mjs backend/tests/reservations-multi-table-static.test.mjs`: OK 27/27.
- Riavviato solo `applicazione-backend.service`; health backend OK.
- Verificato stato server fiscale `http://192.168.1.200:8765/api/fiscal/status`: OK, `fiscalApiEnabled: true`, `dryRun: false`.

## File corretti nel ciclo

- `cassa-frontend/backend/server.js`
- `cassa-frontend/backend/auth/auth.handlers.js`
- `cassa-frontend/backend/modules/configuration/operational-context.js`
- `cassa-frontend/backend/modules/configuration/index.js`
- `cassa-frontend/backend/modules/notifications/waiter-pauses.js`
- `cassa-frontend/backend/tests/auth-session.e2e.test.mjs`
- `cassa-frontend/backend/tests/operational-context-alias.test.mjs`
- `cassa-frontend/backend/tests/payment-weird-cases.e2e.test.mjs`
- `cassa-frontend/backend/tests/route-policy-architecture.test.mjs`
- `cassa-frontend/backend/tests/waiter-pauses.test.mjs`
- `cassa-frontend/frontend-tests/postazione-bridges.test.mjs`
- `postazione/dist/assets/postazione-stations-bootstrap.js`
- `postazione/dist/assets/postazione-station-operator-bridge.js`
- `postazione/dist/assets/postazione-auto-print.js`
- `mobile-frontend/src/api/paymentSettlementEndpoints.ts`
- `mobile-frontend/src/api/printing.ts`
- `mobile-frontend/src/api/tables.ts`
- `mobile-frontend/src/pages/home/components/WaiterPauseCard.tsx`
- `mobile-frontend/src/pages/home/tables/TablesWorkspace.tsx`
- `mobile-frontend/src/pages/home/tables/components/TableDetailPanel.tsx`
- `mobile-frontend/src/pages/payments/PaymentSettlementSection.tsx`
- `mobile-frontend/dist/*`

## Decisioni da mantenere

- La stampa fiscale deve usare RT configurata per l'attivita' operativa, non una RT di fallback.
- La stampa non fiscale deve usare stampante configurata per sala/attivita'/postazione secondo regole esplicite.
- La ristampa fiscale deve chiamare endpoint di ristampa, non riemettere scontrino.
- Le postazioni reali devono arrivare da configurazione/DB, non da mock.
