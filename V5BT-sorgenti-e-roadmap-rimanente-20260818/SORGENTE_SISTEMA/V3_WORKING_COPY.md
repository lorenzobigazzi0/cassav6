# V3 Working Copy

Creata: 2026-06-06

Origine:

- `/srv/applicazione/current`

Destinazione:

- `/srv/applicazione/v3`

Regola operativa:

- `/srv/applicazione/current` resta la versione attiva in produzione/V2.
- Le prossime modifiche vanno fatte su `/srv/applicazione/v3`, salvo richiesta esplicita diversa.
- La V3 e' una copia speculare iniziale della versione attuale, inclusi DB e configurazioni presenti al momento della copia.

Nota:

- Non sono stati riavviati o ripuntati servizi verso V3 durante la creazione.

## Avvio parallelo

Avviata: 2026-06-06 15:20 Europe/Rome

Porte V3:

- Backend V3: `http://127.0.0.1:5281`
- Frontend V3: `https://127.0.0.1:5280`
- Mobile V3: `https://127.0.0.1:5280/mobile/`
- Postazione V3: `https://127.0.0.1:5280/postazione/`
- Monitor V3: `https://127.0.0.1:5280/monitor/`
- Impostazioni V3: `https://127.0.0.1:5280/impostazioni/`
- Mobile LAN V3: `https://192.168.0.28:5280/mobile/`

Processi V3:

- Backend PID: `3451012`
- Frontend PID: `3445139`

DB V3:

- `/srv/applicazione/v3/cassa-frontend/backend/app-state.json`

Regole di isolamento:

- V2 resta attiva su `5180/5181`.
- V3 usa DB separato copiato dalla V2 al momento della creazione.
- La stampa reale non e' stata abilitata esplicitamente su V3 durante questo avvio parallelo, per evitare stampe accidentali.
- I default V3 sono stati riallineati a `5280/5281` per evitare avvii accidentali sulle API V2.
- Il CORS backend V3 accetta la V3 (`5280`) e respinge la V2 (`5180`) nelle chiamate cross-origin.
