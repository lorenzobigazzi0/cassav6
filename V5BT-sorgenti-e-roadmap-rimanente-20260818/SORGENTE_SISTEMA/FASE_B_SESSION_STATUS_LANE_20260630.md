# Fase B/F - Session status fuori dalla coda globale

Data: 2026-06-30

## Obiettivo

Ridurre gli outlier residui su `POST /api/auth/session/status`: quando il fast path deve persistere davvero `lastSeenAt`, non deve piu rientrare nella `dbMutationQueue` globale.

## Implementato

- `auth.handlers.js`
  - aggiunto hook `runSessionStatusMutation`;
  - il fallback persistente del fast path session status usa l'hook se presente;
  - se l'hook non e configurato, resta il fallback precedente.
- `server.js`
  - aggiunto `withSessionStatusLaneMutation`;
  - il fallback persistente di `session/status` passa dalla lane di presenza/postazione gia serializzata;
  - la coda globale resta solo come fallback se la lane viene disabilitata.
- Test runtime:
  - caso heartbeat ravvicinato: niente coda globale;
  - caso heartbeat persistente: `dbMutationEnqueued = 0`, lane enqueued = 1.

## Verifiche

- `node --check cassa-frontend/backend/server.js`
- `node --check cassa-frontend/backend/auth/auth.handlers.js`
- `node --test cassa-frontend/backend/tests/auth-session.e2e.test.mjs`
  - 13/13 pass
- `node --test cassa-frontend/backend/tests/station-pause-transfer.e2e.test.mjs cassa-frontend/backend/tests/runtime-metrics.test.mjs cassa-frontend/backend/tests/route-policy-architecture.test.mjs`
  - 22/22 pass

## Note

- `server.js` resta sotto il limite hard: 39989 righe.
- Il contatore runtime usato e `stationStateLaneEnqueued`, perche la lane gestisce ora gli heartbeat/presenza che toccano sessione o stato postazione.

## Prossimo step consigliato

Misurare un mini-load misto 25/50 device dopo questo cambio, controllando:

- `dbMutationEnqueued` durante heartbeat/session status;
- outlier residui legati ai retry fiscali pendenti;
- impatto su `GET /api/integration/orders?station=...` p95/p99.
