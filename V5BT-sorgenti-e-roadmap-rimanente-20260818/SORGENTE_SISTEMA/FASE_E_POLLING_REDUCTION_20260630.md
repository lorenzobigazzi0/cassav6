# Fase E - Riduzione Polling Ridondante

Data: 2026-06-30
Sorgente: `estratto/v4.0.2-20260629-181421/sistema-cassa-v4.0.2-source`

## Scopo

Avviare Fase E della roadmap `ROADMAP_REALTIME_CASSAV4.md`: con `SSE_EVENT_PAYLOAD=1` attivo, usare lo stream come canale primario e lasciare i poll come fallback lento o riconciliazione mirata.

## Modifiche

- Aggiunto stato realtime condiviso nel mobile:
  - `pos:realtime-transport-status`
  - stato `connecting`, `connected`, `disconnected`, `unavailable`
  - hook `useRealtimeTransportStatus`
- `useNotificationTransportSync`:
  - rimosso il poll continuo ogni 1,5 s quando SSE e' connesso;
  - introdotto fallback poll ogni 15 s solo se EventSource non esiste o lo stream cade;
  - alla connessione/riconnessione fa una sola riconciliazione notifiche;
  - pubblica lo stato transport per Home, Tavoli e settings.
- `HomeCard`:
  - il dashboard non fa piu' refetch ogni 30 s quando SSE e' connesso;
  - resta safety poll a 90 s quando SSE non e' connesso;
  - alla riconnessione fa una sola `refetch`.
- `TablesWorkspace`:
  - rimossi gli hot poll continui su rooms, tables e menu quando SSE e' connesso;
  - resta safety poll a 90 s quando SSE non e' connesso;
  - alla riconnessione fa una sola riconciliazione mirata di room, tavoli e menu.
- `useSettingsLiveSync`:
  - ascolta `settings.updated` via `pos:server-payload`;
  - usa `/api/health` solo come baseline iniziale e fallback a 90 s quando SSE non e' connesso.
- Backend settings:
  - i salvataggi principali delle impostazioni pubblicano `settings_updated` con `version` e `settingsVersion`.
- Backend menu:
  - il salvataggio menu pubblica ora `settings_updated` con `version` e `settingsVersion`, cosi' i client possono aggiornare il catalogo via push.
- Altri poll web:
  - `SystemConnectionStatusContext` non chiama piu' `/api/health` a ogni evento SSE sano e sospende il probe periodico quando SSE e' connesso;
  - `WaiterPauseCard` ascolta `waiter_pause_started/stopped` via SSE e passa a safety refresh 90 s con SSE connesso;
  - `MenuWorkspace` e `useMenuSessionSync` passano a safety refresh 90 s con SSE connesso e reagiscono a `settings_updated`.
- Frontend postazione:
  - rimosso il sync completo ogni 2 s;
  - heartbeat leggero ogni 15 s;
  - sync completo ogni 90 s quando SSE e' connesso;
  - sync completo ogni 15 s quando SSE non e' connesso;
  - sync immediato una sola volta su prima connessione/riconnessione SSE;
  - protezione da sync completi concorrenti.
- Android E2:
  - `NativeNotificationPoller` e' stato declassato da 4 s a 20 s;
  - il poller si spegne in foreground, dove WebView/SSE resta il canale primario;
  - il servizio `AlwaysOnService` notifica al poller i cambi foreground/background.
- E3 riconciliazioni residue:
  - la coda offline integrazione tavoli non riprova piu' ogni 15 s: ora flush immediato su enqueue, ritorno online,
    ritorno visibilita' e riconnessione SSE; resta fallback lento a 90 s;
  - il widget batteria mobile mantiene lo stream `/api/mobile/battery/events` come canale primario e declassa il
    fallback HTTP da 1,5 s a 30 s;
  - la dashboard `/batteria` usa lo stream `/api/battery/events` e fa fetch dello snapshot solo su ready/evento
    batteria o fallback lento a 30 s se EventSource non e' disponibile;
  - `tableLocks` resta heartbeat operativo: e' una lease attiva e non un polling ridondante;
  - cassa automatica e cambio contanti restano a refresh stretto solo mentre la modale operativa e' aperta, per non
    perdere depositi/resto durante un pagamento live.

## Verifica

Test eseguiti:

- `node --check cassa-frontend/backend/server.js` -> pass
- `node --check cassa-frontend/backend/modules/settings/settings.handlers.js` -> pass
- `node --check cassa-frontend/backend/modules/menu/menu.handlers.js` -> pass
- `npm run typecheck` in `mobile-frontend` -> pass
- `npm run build` in `mobile-frontend` -> pass
- `npm run build` in `postazione` -> pass
- `node --test cassa-frontend/backend/tests/notification-stream-payload.test.mjs` -> 1/1 pass
- `npm run build` in `battery-dashboard` -> pass
- `node --check battery-dashboard/server/index.js` -> pass
- `node --test cassa-frontend/backend/tests/mobile-battery.test.mjs` -> 5/5 pass
- Riavvio live `./tools/restart-cassav4-linux.sh` -> backend OK, frontend HTTPS OK
- Health live `http://127.0.0.1:5281/api/health` -> `database.mode=mysql`
- Flag runtime backend confermati: `SSE_EVENT_PAYLOAD=1`, `APP_STATE_DIRTY_TRACKING=1`, `PRINT_SPOOL_FAST_WORKER=1`

Bundle generati:

- Mobile live corrente: `/mobile/assets/index-AvC-4cY4.js`
- Postazione live corrente: `/postazione/assets/index-CobQx9_z.js`
- Batteria live corrente: `/batteria/assets/index-uYID1fLh.js`

Nota Android: la sorgente e' stata aggiornata in `estratto/v4.0.2-20260629-181421/android-webview-app-source`, ma in questo ambiente non e' disponibile un Gradle reale (`gradle` assente e `gradlew` nello zip e' un wrapper minimale non eseguibile). La verifica Android completa va fatta aprendo il progetto in Android Studio o con un wrapper Gradle reale.

## Esito

Fase E1 e' applicata ai flussi web piu' rumorosi e ad altri poll secondari: notifiche mobile, Home, Tavoli, settings, menu, pausa cameriere, health probe e postazione. E2 Android e' avviata declassando il poller nativo a fallback background. E3 e' chiusa sulle riconciliazioni residue principali: coda offline tavoli e batteria/dashboard sono push-first con fallback lento. Il push SSE resta il percorso primario; i poll non spariscono del tutto, ma diventano recupero lento, riconciliazione dopo disconnessione o monitor operativo durante procedure live.

## Prossimo Passo

STOP/REVIEW Fase E. Il prossimo step della roadmap e' Fase B, iniziando da B-payments: analisi e isolamento delle lane per pagamenti/fiscale prima di toccare gli altri domini.
