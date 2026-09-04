# Runtime inventory — Fase -1/0

## Launcher rilevati

Launcher nuovi introdotti in questa fase:

- `launcher/start-standard.cmd`
- `launcher/start-standard.sh`
- `launcher/start-near-realtime.cmd`
- `launcher/start-near-realtime.sh`
- `launcher/start-near-realtime-redis.cmd`
- `launcher/start-near-realtime-redis.sh`
- `launcher/start-near-realtime-mqtt.cmd`
- `launcher/start-near-realtime-mqtt.sh`
- `launcher/start-canary-multiprocess.cmd`
- `launcher/start-canary-multiprocess.sh`
- `launcher/start-rollback-safe.cmd`
- `launcher/start-rollback-safe.sh`
- `launcher/_start-profile.cmd`
- `launcher/_start-profile.sh`

Launcher storici rilevati nel bundle:

- `../AVVIA_CASSAV2_ATTUALE.cmd`
- `../tools/start-cassav2-current.ps1`
- `../tools/start-v3-backend-mysql-local.sh`
- `../tools/restart-cassav4-linux.sh`
- altri script operativi in `../tools/`.

## Script package.json aggiunti

- `npm run profile:runtime`
- `npm run hygiene:release`
- `npm run hygiene:release:warn`
- `npm run baseline:parse`
- `npm run test:phase0`

## Note operative

I launcher nuovi non cambiano la logica business. Caricano un profilo, stampano la matrice runtime e poi avviano il backend con `npm run dev:backend`.

Per produzione reale non usare direttamente gli `.env.example`: copiare il file desiderato in `.env` fuori dal repository oppure gestire i segreti tramite variabili di ambiente/servizio di deployment.
