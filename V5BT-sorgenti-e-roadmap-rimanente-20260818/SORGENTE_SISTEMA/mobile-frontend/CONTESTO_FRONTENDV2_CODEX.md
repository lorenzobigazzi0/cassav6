# FrontendV2 - contesto per altro Codex

Data contesto: 2026-05-19.

## Primo comando / messaggio da dare a Codex

```text
Apri C:\Users\utente\Desktop\applicazione\pos-frontend\handoff\CONTESTO_FRONTENDV2_CODEX.md, lavora su C:\Users\utente\Desktop\applicazione\pos-frontend e continua la migrazione mobile FrontendV2. Prima verifica npm run build, backend health su http://127.0.0.1:5181/api/health e frontend su http://127.0.0.1:5190/mobile/. Non revertare modifiche esistenti.
```

## Primo comando shell utile

```powershell
cd C:\Users\utente\Desktop\applicazione\pos-frontend; npm run build; cd C:\Users\utente\Desktop\applicazione\cash-frontend; node --check backend\server.js
```

## Percorsi principali

- Frontend mobile: `C:\Users\utente\Desktop\applicazione\pos-frontend`
- Backend stabile/mock: `C:\Users\utente\Desktop\applicazione\cash-frontend`
- Frontend dev server: `http://127.0.0.1:5190/mobile/`
- Backend: `http://127.0.0.1:5181`

## Stato verificato

- `npm run build` in `pos-frontend`: OK
- `node --check backend\server.js` in `cash-frontend`: OK
- `backend\mock-db.json`: JSON valido
- Frontend `/mobile/`: HTTP 200
- Backend `/api/health`: HTTP 200
- Nessun residuo `gianluca` / `Gianluca` nei sorgenti frontend e nei file backend controllati
- Test lock backend autenticato fatto con utente `lorenzo`, poi sessione smoke ripulita

## Lavoro gia integrato

- Rimosso username `gianluca` dal frontend e poi anche dai seed/mock backend.
- Logo login spostato sopra la glass card.
- Integrati diversi vecchi bridge mobile in sorgente React:
  - print storico ordini
  - reminder notifiche
  - fix payment layout ordine
  - abbuono storico ordini
  - disponibilita menu
  - persistenza sessione pagamento
  - home dashboard
  - analytics payment movements
  - payments settlement
- Per `order service recovery` e stata fatta una fase parziale ma stabile:
  - i pulsanti `Modifica` e `Reso bar` nel preview storico sono ora renderizzati da React in `TableDetailPanel.tsx`;
  - il bridge rileva `data-native-service-recovery-actions` e non sovrascrive piu quei pulsanti;
  - le righe ordine lette da integrazione portano `lineId`, `productId`, prezzi, `lineType`, `voidedAt`;
  - il preview mostra prezzi riga nativamente quando disponibili;
  - il bridge espone anche `window.__mobileOrderServiceRecoveryOpenCorrection`.

## Backend aggiunto

Nel backend stabile `cash-frontend/backend/server.js` sono stati aggiunti gli endpoint minimi chiamati dai bridge:

- `POST /api/tables/lock/acquire`
- `POST /api/tables/lock/heartbeat`
- `POST /api/tables/lock/release`
- `POST /api/integration/orders/correct`
- `POST /api/integration/orders/cancel`
- `POST /api/integration/orders/storno`
- `POST /api/integration/orders/comp`

Gli endpoint nuovi senza sessione rispondono 400/401, non 404: il routing li intercetta.

## Bridge rimasti

In `src/mobile/installLegacyMobileBridges.ts` restano ancora:

- `installMobileOrderServiceRecoveryBridge`
- `installMobileTableGroupsBridge`
- `installMobileTableLockLifecycleBridge`

`order service recovery` non e ancora completamente rimosso: mantiene ancora la modale operativa e alcune parti DOM-based. Non eliminarlo finche la modale React e gli endpoint non sono stati testati end-to-end.

## File frontend importanti

- `src/api/tables.ts`
- `src/pages/home/tables/components/TableDetailPanel.tsx`
- `src/styles/tables.css`
- `src/styles/glass.css`
- `src/mobile/installLegacyMobileBridges.ts`
- `src/mobile/legacyBridges/installMobileOrderServiceRecoveryBridge.ts`
- `src/api/analyticsPaymentMovements.ts`
- `src/pages/home/analytics/AnalyticsWorkspace.tsx`
- `src/pages/payments/PaymentSettlementSection.tsx`
- `src/pages/PaymentsPage.tsx`
- `vite.config.ts`

## File backend importanti

- `C:\Users\utente\Desktop\applicazione\cash-frontend\backend\server.js`
- `C:\Users\utente\Desktop\applicazione\cash-frontend\backend\mock-db.json`

## Prossime fasi consigliate

1. Test manuale su tavolo con comanda reale: aprire storico, preview ordine, pulsanti `Modifica` e `Reso bar`.
2. Validare `orders/correct`, `orders/storno`, `orders/comp`, `orders/cancel` con payload reale.
3. Solo dopo, migrare la modale `order service recovery` in React.
4. Poi affrontare `table groups` o `table lock lifecycle`, sapendo che sono bridge grandi e ancora molto DOM-based.

